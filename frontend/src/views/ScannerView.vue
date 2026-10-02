<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'

const router = useRouter()

const switches = ref([])
const deployments = ref([])
const loadingData = ref(true)

const cameras = ref([])
const selectedCameraId = ref('')
const isScanning = ref(false)
const cameraError = ref('')
const scannedText = ref('')
const matchedSwitch = ref(null)
const matchedDeployment = ref(null)
const scanHistory = ref([])
const autoRedirect = ref(true)
const redirectCountdown = ref(0)
let countdownTimer = null

let html5QrCode = null

const fetchFleetAndDeployments = async () => {
  loadingData.value = true
  try {
    const [fleetRes, depRes] = await Promise.all([
      fetch('/api/fleet', { credentials: 'include' }),
      fetch('/api/deployments', { credentials: 'include' })
    ])
    if (fleetRes.ok) {
      const fData = await fleetRes.json()
      switches.value = fData.switches || []
    }
    if (depRes.ok) {
      const dData = await depRes.json()
      deployments.value = dData || []
    }
  } catch (err) {
    console.warn('Failed to load fleet/deployments for matching:', err)
  } finally {
    loadingData.value = false
  }
}

const findMatch = (text) => {
  if (!text) return { sw: null, dep: null }
  const raw = text.trim()
  const lower = raw.toLowerCase()
  const cleanHex = raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase()

  // 1. Direct match on serial number in switches
  let sw = switches.value.find(s => s.serial_number && s.serial_number.toLowerCase() === lower)
  if (sw) return { sw, dep: null }

  // 2. Direct match on inventory tag
  sw = switches.value.find(s => s.inventory_tag && s.inventory_tag.toLowerCase() === lower)
  if (sw) return { sw, dep: null }

  // 3. Direct match on management IP
  sw = switches.value.find(s => s.mgmt_ip && s.mgmt_ip === raw)
  if (sw) return { sw, dep: null }

  // 4. Match on MAC address
  if (cleanHex.length >= 12) {
    sw = switches.value.find(s => {
      if (!s.mac_address) return false
      const swMac = s.mac_address.replace(/[^a-fA-F0-9]/g, '').toLowerCase()
      return swMac && (cleanHex.includes(swMac) || swMac.includes(cleanHex))
    })
    if (sw) return { sw, dep: null }
  }

  // 5. Token match across words/delimiters
  const tokens = raw.split(/[\s,;|\n\r]+/).map(t => t.trim().replace(/^(?:SN|S\/N|MAC|IP|TAG):/i, '')).filter(Boolean)
  for (const token of tokens) {
    const tokLower = token.toLowerCase()
    sw = switches.value.find(s =>
      (s.serial_number && s.serial_number.toLowerCase() === tokLower) ||
      (s.inventory_tag && s.inventory_tag.toLowerCase() === tokLower) ||
      (s.mgmt_ip && s.mgmt_ip === token) ||
      (s.hostname && s.hostname.toLowerCase() === tokLower)
    )
    if (sw) return { sw, dep: null }
  }

  // 6. Substring match for serial number if long enough
  if (raw.length >= 6) {
    sw = switches.value.find(s => s.serial_number && (lower.includes(s.serial_number.toLowerCase()) || s.serial_number.toLowerCase().includes(lower)))
    if (sw) return { sw, dep: null }
  }

  // 7. Check deployments table if not yet active in fleet
  let dep = deployments.value.find(d =>
    (d.serial_number && d.serial_number.toLowerCase() === lower) ||
    (d.inventory_tag && d.inventory_tag.toLowerCase() === lower) ||
    (d.mgmt_ip && d.mgmt_ip === raw)
  )

  return { sw: null, dep: dep || null }
}

const onScanSuccess = (decodedText) => {
  if (!decodedText || decodedText === scannedText.value) return
  scannedText.value = decodedText

  const { sw, dep } = findMatch(decodedText)
  matchedSwitch.value = sw
  matchedDeployment.value = dep

  scanHistory.value.unshift({
    text: decodedText,
    time: new Date().toLocaleTimeString(),
    matched: !!sw || !!dep,
    name: sw ? (sw.hostname || sw.mgmt_ip) : (dep ? dep.hostname : null),
    id: sw ? sw.id : (dep ? dep.id : null),
    isDeployment: !sw && !!dep
  })

  // Beep feedback
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = sw ? 880 : 440
    gain.gain.value = 0.1
    osc.start()
    osc.stop(ctx.currentTime + 0.15)
  } catch (e) {}

  // Auto-redirect if match found and enabled
  if (sw && autoRedirect.value) {
    redirectCountdown.value = 2
    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = setInterval(() => {
      redirectCountdown.value--
      if (redirectCountdown.value <= 0) {
        clearInterval(countdownTimer)
        stopCamera()
        router.push(`/fleet/${sw.id}`)
      }
    }, 1000)
  }
}

const startCamera = async () => {
  cameraError.value = ''
  try {
    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode('qr-reader', {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.UPC_A
        ],
        verbose: false
      })
    }

    const devices = await Html5Qrcode.getCameras()
    cameras.value = devices || []

    let cameraIdOrConfig = { facingMode: 'environment' }
    if (selectedCameraId.value) {
      cameraIdOrConfig = { deviceId: { exact: selectedCameraId.value } }
    } else if (devices && devices.length > 0) {
      // Prefer back / environment camera if available
      const backCam = devices.find(d => /back|rear|environment/i.test(d.label))
      selectedCameraId.value = backCam ? backCam.id : devices[0].id
      cameraIdOrConfig = { deviceId: { exact: selectedCameraId.value } }
    }

    await html5QrCode.start(
      cameraIdOrConfig,
      {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const edge = Math.min(viewfinderWidth, viewfinderHeight) * 0.75
          return { width: Math.round(edge), height: Math.round(edge) }
        },
        aspectRatio: 1.0
      },
      (decodedText) => {
        onScanSuccess(decodedText)
      },
      () => {}
    )

    isScanning.value = true
  } catch (err) {
    console.error('Camera startup error:', err)
    cameraError.value = err.message || 'Unable to access camera. Please ensure permissions are granted.'
    isScanning.value = false
  }
}

const stopCamera = async () => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (html5QrCode && isScanning.value) {
    try {
      await html5QrCode.stop()
      html5QrCode.clear()
    } catch (e) {}
    isScanning.value = false
  }
}

const switchCamera = async () => {
  await stopCamera()
  await startCamera()
}

const handleFileUpload = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  try {
    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode('qr-reader', {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39
        ]
      })
    }
    const decoded = await html5QrCode.scanFile(file, true)
    if (decoded) onScanSuccess(decoded)
  } catch (err) {
    cameraError.value = 'No recognizable DataMatrix or barcode found in this image.'
  }
}

const cancelRedirect = () => {
  if (countdownTimer) clearInterval(countdownTimer)
  redirectCountdown.value = 0
}

const goToMatched = () => {
  stopCamera()
  if (matchedSwitch.value) {
    router.push(`/fleet/${matchedSwitch.value.id}`)
  } else if (matchedDeployment.value) {
    router.push(`/history`)
  }
}

const clearScan = () => {
  cancelRedirect()
  scannedText.value = ''
  matchedSwitch.value = null
  matchedDeployment.value = null
}

onMounted(async () => {
  await fetchFleetAndDeployments()
  await startCamera()
})

onUnmounted(() => {
  stopCamera()
})
</script>

<template>
  <div class="max-w-[1000px] mx-auto px-5 py-4">
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <div class="flex items-center gap-2">
          <button @click="router.push('/fleet')" class="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors">
            <Icon icon="lucide:arrow-left" class="w-5 h-5" />
          </button>
          <h1 class="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Icon icon="carbon:qr-code" class="w-6 h-6 text-primary" />
            Switch DataMatrix & Barcode Scanner
          </h1>
        </div>
        <p class="text-sm text-muted-foreground mt-1 ml-8">
          Scan the DataMatrix code, serial sticker, or asset tag on a Ruijie switch to inspect its running configuration and live status.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="router.push('/fleet')">
          <Icon icon="carbon:network-4" class="w-4 h-4 mr-1.5" />
          Fleet List
        </Button>
      </div>
    </div>

    <!-- Scanner & Results Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- Left Column: Camera Viewport -->
      <div class="lg:col-span-7 space-y-4">
        <div class="border rounded-2xl bg-card overflow-hidden shadow-xs relative">
          <!-- Viewport Header -->
          <div class="p-3.5 border-b bg-muted/30 flex items-center justify-between">
            <div class="flex items-center gap-2 text-xs font-semibold">
              <span
                class="w-2 h-2 rounded-full"
                :class="isScanning ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400'"
              />
              <span>{{ isScanning ? 'Camera Active' : 'Camera Paused' }}</span>
            </div>

            <!-- Camera Switcher -->
            <div v-if="cameras.length > 1" class="flex items-center gap-2">
              <select
                v-model="selectedCameraId"
                @change="switchCamera"
                class="text-xs border rounded px-2 py-1 bg-background text-foreground"
              >
                <option v-for="cam in cameras" :key="cam.id" :value="cam.id">
                  {{ cam.label || 'Camera ' + cam.id }}
                </option>
              </select>
            </div>
          </div>

          <!-- HTML5 Video Container -->
          <div class="relative bg-black min-h-[340px] flex items-center justify-center overflow-hidden">
            <div id="qr-reader" class="w-full max-w-[500px]"></div>

            <div v-if="cameraError" class="absolute inset-0 bg-background/90 backdrop-blur-xs flex flex-col items-center justify-center p-6 text-center space-y-3 z-10">
              <div class="w-12 h-12 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center">
                <Icon icon="carbon:warning" class="w-6 h-6" />
              </div>
              <div class="font-semibold text-sm">{{ cameraError }}</div>
              <p class="text-xs text-muted-foreground max-w-sm">
                Ensure camera permissions are allowed in your browser, or upload an image containing the DataMatrix barcode below.
              </p>
              <Button size="sm" variant="outline" @click="startCamera">
                <Icon icon="lucide:rotate-ccw" class="w-3.5 h-3.5 mr-1.5" />
                Retry Camera
              </Button>
            </div>
          </div>

          <!-- Viewport Controls & File Upload -->
          <div class="p-3.5 border-t bg-muted/20 flex items-center justify-between gap-3 text-xs">
            <div class="flex items-center gap-2">
              <label class="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-background hover:bg-muted text-foreground transition-colors font-medium">
                <Icon icon="lucide:upload" class="w-3.5 h-3.5 text-muted-foreground" />
                <span>Upload Image</span>
                <input type="file" accept="image/*" class="hidden" @change="handleFileUpload" />
              </label>

              <Button
                v-if="isScanning"
                variant="ghost"
                size="sm"
                class="h-8 text-xs"
                @click="stopCamera"
              >
                <Icon icon="lucide:pause" class="w-3.5 h-3.5 mr-1" />
                Pause
              </Button>
              <Button
                v-else
                variant="ghost"
                size="sm"
                class="h-8 text-xs text-primary"
                @click="startCamera"
              >
                <Icon icon="lucide:play" class="w-3.5 h-3.5 mr-1" />
                Resume
              </Button>
            </div>

            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
                <input type="checkbox" v-model="autoRedirect" class="rounded text-primary focus:ring-0" />
                <span>Auto-open match</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Help Notice -->
        <div class="p-3.5 rounded-xl border bg-card/60 text-xs text-muted-foreground space-y-1">
          <div class="font-semibold text-foreground flex items-center gap-1.5">
            <Icon icon="carbon:information" class="w-4 h-4 text-primary" />
            Scanning Ruijie Switch Labels
          </div>
          <p>
            Ruijie switches feature DataMatrix 2D codes beside the serial number or MAC address label. The scanner detects standard <strong>DataMatrix</strong>, <strong>QR Codes</strong>, and <strong>Code 128 barcodes</strong>.
          </p>
        </div>
      </div>

      <!-- Right Column: Scan Detection Card & History -->
      <div class="lg:col-span-5 space-y-4">
        <!-- Detection Result Card -->
        <div class="border rounded-2xl bg-card shadow-xs overflow-hidden">
          <div class="p-4 border-b bg-muted/30 flex items-center justify-between">
            <h2 class="text-sm font-bold flex items-center gap-2">
              <Icon icon="carbon:checkmark-outline" class="w-4 h-4 text-primary" />
              Scan Result
            </h2>
            <Button
              v-if="scannedText"
              variant="ghost"
              size="sm"
              class="h-6 text-xs px-2 text-muted-foreground hover:text-foreground"
              @click="clearScan"
            >
              Clear
            </Button>
          </div>

          <div class="p-5 space-y-4">
            <div v-if="!scannedText" class="py-12 text-center text-muted-foreground space-y-2">
              <Icon icon="carbon:scan" class="w-10 h-10 mx-auto opacity-40 animate-pulse" />
              <div class="text-sm font-medium">Awaiting DataMatrix code...</div>
              <p class="text-xs text-muted-foreground max-w-xs mx-auto">
                Position the switch 2D DataMatrix code in front of the lens.
              </p>
            </div>

            <div v-else class="space-y-4">
              <!-- Raw Scanned Payload -->
              <div class="p-3 rounded-lg bg-muted/50 border font-mono text-xs break-all">
                <div class="text-[10px] text-muted-foreground font-sans uppercase font-bold tracking-wider mb-1">
                  Decoded Content
                </div>
                <div class="text-foreground font-semibold select-all">{{ scannedText }}</div>
              </div>

              <!-- Matched Switch in Fleet -->
              <div v-if="matchedSwitch" class="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-emerald-600 flex items-center gap-1.5 uppercase tracking-wide">
                    <Icon icon="carbon:checkmark-filled" class="w-4 h-4" />
                    Fleet Match Found
                  </span>
                  <Badge
                    :variant="matchedSwitch.status === 'online' ? 'default' : 'secondary'"
                    class="capitalize text-[11px] px-2 py-0"
                    :class="matchedSwitch.status === 'online' ? 'bg-emerald-600' : ''"
                  >
                    {{ matchedSwitch.status }}
                  </Badge>
                </div>

                <div class="space-y-1">
                  <div class="text-base font-bold text-foreground">
                    {{ matchedSwitch.hostname || 'Switch ' + matchedSwitch.mgmt_ip }}
                  </div>
                  <div class="text-xs text-muted-foreground font-mono">
                    IP: <strong class="text-foreground">{{ matchedSwitch.mgmt_ip }}</strong> • Model: {{ matchedSwitch.model_id || 'Ruijie' }}
                  </div>
                  <div v-if="matchedSwitch.serial_number" class="text-xs text-muted-foreground font-mono">
                    S/N: {{ matchedSwitch.serial_number }}
                  </div>
                  <div v-if="matchedSwitch.inventory_tag" class="text-xs text-muted-foreground font-mono">
                    Tag: {{ matchedSwitch.inventory_tag }}
                  </div>
                </div>

                <!-- Auto-redirect banner -->
                <div v-if="redirectCountdown > 0" class="pt-1 flex items-center justify-between text-xs text-emerald-700 dark:text-emerald-300">
                  <span>Redirecting in <strong>{{ redirectCountdown }}s</strong>...</span>
                  <button @click="cancelRedirect" class="underline hover:text-foreground">
                    Cancel
                  </button>
                </div>

                <div class="pt-1">
                  <Button class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium" @click="goToMatched">
                    <Icon icon="carbon:network-4" class="w-4 h-4 mr-1.5" />
                    Open Switch Details & Config
                  </Button>
                </div>
              </div>

              <!-- Matched Deployment (Not yet in Fleet) -->
              <div v-else-if="matchedDeployment" class="p-4 rounded-xl border border-blue-500/30 bg-blue-500/10 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-blue-600 flex items-center gap-1.5 uppercase tracking-wide">
                    <Icon icon="carbon:document" class="w-4 h-4" />
                    Found in Deployments
                  </span>
                </div>

                <div class="space-y-1">
                  <div class="text-base font-bold text-foreground">
                    {{ matchedDeployment.hostname || 'Provisioned Switch' }}
                  </div>
                  <div class="text-xs text-muted-foreground font-mono">
                    IP: {{ matchedDeployment.mgmt_ip || '-' }} • Model: {{ matchedDeployment.model_id }}
                  </div>
                  <div class="text-xs text-muted-foreground font-mono">
                    Tag: {{ matchedDeployment.inventory_tag }}
                  </div>
                </div>

                <div class="pt-1">
                  <Button variant="outline" class="w-full" @click="router.push('/history')">
                    <Icon icon="carbon:document-view" class="w-4 h-4 mr-1.5" />
                    View in Deployment History
                  </Button>
                </div>
              </div>

              <!-- No Match -->
              <div v-else class="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2">
                <div class="font-bold text-xs text-amber-600 flex items-center gap-1.5">
                  <Icon icon="carbon:warning" class="w-4 h-4" />
                  No Matching Switch in Fleet
                </div>
                <p class="text-xs text-muted-foreground leading-relaxed">
                  The scanned code does not match any current serial number, inventory tag, IP, or MAC in the fleet database.
                </p>
                <div class="pt-1">
                  <Button variant="outline" size="sm" class="w-full text-xs" @click="router.push('/fleet')">
                    <Icon icon="lucide:plus" class="w-3.5 h-3.5 mr-1" />
                    Add this Device Manually
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Recent Scan History -->
        <div v-if="scanHistory.length > 0" class="border rounded-2xl bg-card shadow-xs overflow-hidden">
          <div class="p-3.5 border-b bg-muted/30 flex items-center justify-between">
            <h3 class="text-xs font-bold uppercase tracking-wider text-muted-foreground">Recent Scans</h3>
            <span class="text-[11px] text-muted-foreground">{{ scanHistory.length }} items</span>
          </div>
          <div class="divide-y text-xs max-h-[220px] overflow-y-auto">
            <div
              v-for="(item, idx) in scanHistory"
              :key="idx"
              class="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors cursor-pointer"
              @click="onScanSuccess(item.text)"
            >
              <div class="space-y-0.5 truncate max-w-[200px]">
                <div class="font-semibold text-foreground truncate">
                  {{ item.name || item.text }}
                </div>
                <div class="text-[10px] text-muted-foreground font-mono">
                  {{ item.time }}
                </div>
              </div>
              <Badge :variant="item.matched ? 'default' : 'secondary'" class="text-[10px] px-1.5 py-0">
                {{ item.matched ? 'Matched' : 'Unmatched' }}
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
