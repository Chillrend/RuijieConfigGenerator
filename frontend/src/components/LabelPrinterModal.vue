<script setup>
import { ref, watch, nextTick } from 'vue'
import { GenericPrinter, Job, Label, Media, Resolution } from 'labelprinterkit'
import bwipjs from 'bwip-js'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const props = defineProps({
  open: { type: Boolean, required: true },
  hostname: { type: String, default: '' },
  serialNumber: { type: String, default: '' },
  macAddress: { type: String, default: '' },
  managementIp: { type: String, default: '' },
  inventoryTag: { type: String, default: '' },
})

const emit = defineEmits(['update:open'])

const status = ref('Ready')
const statusColor = ref('text-muted-foreground')
const printing = ref(false)

const canvasRef = ref(null)

// 1. Custom transport to map the library to your Bluetooth connection
class WebSerialTransport {
    constructor(port) {
        this.port = port;
        this.writer = null;
        this.detectedMediaType = null;
        this.detectedMediaWidth = null;
    }
    async connect() {
        if (!this.port.readable) {
            await this.port.open({ baudRate: 9600 });
        }
        this.writer = this.port.writable.getWriter();
    }
    async disconnect() {
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close();
    }
    async write(data) {
        // Intercept outgoing Brother Raster stream
        for (let i = 0; i < data.length - 4; i++) {
            // Search for the 'ESC i z' (0x1B, 0x69, 0x7A) Print Information command
            if (data[i] === 0x1B && data[i+1] === 0x69 && data[i+2] === 0x7A) {
                // data[i+3] is the command flag:
                // 0x84 = PI.recover (0x80) | PI.width (0x04)
                // This tells the printer to only check the tape width (18mm) and NOT reject other tape kinds!
                data[i+3] = 0x84;

                // data[i+4] is the Media Type byte
                if (this.detectedMediaType != null) {
                    data[i+4] = this.detectedMediaType;
                }

                // data[i+5] is the Media Width byte
                data[i+5] = this.detectedMediaWidth || 18;

                // data[i+7]..data[i+10] is the raster line count (400 lines)
                data[i+7] = 400 & 0xff;
                data[i+8] = (400 >> 8) & 0xff;
                data[i+9] = 0x00;
                data[i+10] = 0x00;

                console.log(`Patched ESC i z: flags=0x${data[i+3].toString(16)}, type=0x${data[i+4].toString(16)}, width=${data[i+5]}mm, lines=400`);
                break; 
            }
        }
        
        // Blast the modified bytes to the Bluetooth port
        await this.writer.write(data);
    }
    async read(count = 32) {
        const reader = this.port.readable.getReader();
        const buffer = new Uint8Array(count);
        let offset = 0;
        
        try {
            // Read the REAL status from the printer
            while (offset < count) {
                const { value, done } = await reader.read();
                if (done) break;
                
                const lengthToCopy = Math.min(value.length, count - offset);
                buffer.set(value.slice(0, lengthToCopy), offset);
                offset += lengthToCopy;
            }
        } finally {
            reader.releaseLock();
        }
        
        // 2. THE INTERCEPT: Check if it's a valid Brother status packet (starts with 0x80)
        if (buffer[0] === 0x80) {
            const rawWidth = buffer[10];
            const rawType = buffer[11];
            console.log(`Printer status: width=${rawWidth}mm, type=0x${rawType.toString(16)}, status=0x${buffer[18].toString(16)}, err=[0x${buffer[8].toString(16)}, 0x${buffer[9].toString(16)}]`);

            // Capture the real physical tape type and width
            if (rawType > 0 && rawType !== 0xff) {
                this.detectedMediaType = rawType;
            }
            if (rawWidth > 0) {
                this.detectedMediaWidth = rawWidth;
            }

            // Spoof media width (byte 10) and media type (byte 11) for the library's Status parser
            // so getMedia(18, 0x01) resolves to Media.W18 without throwing MEDIA_MISMATCH
            buffer[10] = 18;
            buffer[11] = 0x01;

            // Clear REPLACE_MEDIA error flag (bit 0 of error byte 2 at index 9)
            buffer[9] &= ~0x01;
        }
        
        return buffer;
    }
}

const drawLabel = async () => {
  if (!canvasRef.value) return
  
  const canvas = canvasRef.value
  canvas.width = 400
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  
  // Clear background to white
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  
  ctx.fillStyle = 'black'
  
  // Left side: Text
  ctx.font = 'bold 32px Arial'
  ctx.fillText(props.hostname || 'Unknown Host', 10, 36)
  
  ctx.font = '22px Arial'
  ctx.fillText(props.inventoryTag || 'No Tag', 10, 68)
  
  ctx.font = '20px Arial'
  ctx.fillText(`IP: ${props.managementIp || 'DHCP/None'}`, 10, 94)
  
  ctx.font = '20px Arial'
  ctx.fillText(`S/N: ${props.serialNumber || 'N/A'}`, 10, 118)

  // Right side: DataMatrix barcode
  if (props.inventoryTag) {
    // Generate barcode to a temporary hidden canvas first
    const tempCanvas = document.createElement('canvas')
    try {
      bwipjs.toCanvas(tempCanvas, {
        bcid: 'datamatrix',
        text: props.inventoryTag,
        scale: 3, 
        height: 10,
        includetext: false,
      })
      // Draw the temporary canvas onto the main canvas, aligned right
      const xPos = canvas.width - tempCanvas.width - 15
      const yPos = (canvas.height - tempCanvas.height) / 2
      ctx.drawImage(tempCanvas, xPos, yPos)
    } catch (e) {
      console.error("Barcode generation failed", e)
      ctx.font = 'italic 16px Arial'
      ctx.fillText("Barcode err", 300, 64)
    }
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    status.value = 'Ready'
    statusColor.value = 'text-muted-foreground'
    printing.value = false
    nextTick(() => {
      drawLabel()
    })
  }
})

const printLabel = async () => {
    if (!navigator.serial) {
        status.value = "Error: Web Serial API not supported in this browser."
        statusColor.value = "text-destructive"
        return
    }

    printing.value = true
    try {
        status.value = "Requesting Bluetooth port..."
        statusColor.value = "text-primary"
        
        const port = await navigator.serial.requestPort()
        
        status.value = "Connecting..."
        const transport = new WebSerialTransport(port)
        await transport.connect()

        const printer = new GenericPrinter(transport)
        printer._assertStatus = (status, job) => {
            const flags = status.errors?.flags || {};
            if (flags.COVER_OPEN) throw new Error("Printer cover is open. Please close it.");
            if (flags.CUTTER_JAM) throw new Error("Printer cutter jam detected.");
            if (flags.OVERHEATING) throw new Error("Printer is overheating.");
            if (flags.WEAK_BATTERY) throw new Error("Printer battery is low.");
            console.log("Status assertion passed.");
        };
        
        const media = Media.W18 
        const resolution = Resolution.LOW 

        // Get the canvas we already drew on
        const canvas = canvasRef.value
        
        const label = new Label(resolution, canvas)
        
        const job = new Job(media, {
            resolution,
            autoCut: false
        });
        job.addPage(label)

        status.value = "Printing..."
        await printer.print(job)

        status.value = "Feeding label..."
        await new Promise(r => setTimeout(r, 4000))

        await transport.disconnect()
        status.value = "Print complete! Cut tape manually."
        statusColor.value = "text-green-600 font-bold"

    } catch (error) {
        console.error("Print failed:", error)
        status.value = "Error: " + error.message
        statusColor.value = "text-destructive"
    } finally {
        printing.value = false
    }
}
</script>

<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>Print Label (18mm)</DialogTitle>
        <DialogDescription>
          Ensure your Brother PT-E310BT printer is turned on and paired via Bluetooth.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-6 py-4">
        <div class="space-y-2">
          <p class="text-sm font-medium">Print Preview</p>
          <div class="bg-gray-200 border border-gray-300 rounded flex items-center justify-center p-6 overflow-x-auto">
             <canvas ref="canvasRef" class="border shadow-sm max-w-full" style="image-rendering: pixelated;"></canvas>
          </div>
        </div>

        <div class="bg-muted/50 border rounded-md p-3 text-sm flex items-center gap-3">
            <span class="font-medium">Status:</span>
            <span :class="statusColor">{{ status }}</span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)" :disabled="printing">
          Cancel
        </Button>
        <Button @click="printLabel" :disabled="printing">
          {{ printing ? 'Printing...' : 'Connect & Print Label' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
