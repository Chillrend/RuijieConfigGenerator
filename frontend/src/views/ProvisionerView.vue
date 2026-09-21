<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { io } from 'socket.io-client'
import QrcodeVue from 'qrcode.vue'
import JsBarcode from 'jsbarcode'
import bwipjs from 'bwip-js'

// Import Shadcn UI Components
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'

// ── State ────────────────────────────────────────────────────
const isInitialized = ref(false)
const serialNumber = ref('')
const macAddress = ref('')
const initError = ref('')

const inventoryTag = ref('')
const hostname = ref('')
const adminUsername = ref('admin')
const adminPassword = ref('')
const enablePassword = ref('')
const enableSsh = ref(true)
const enableWeb = ref(true)
const enableCwmp = ref(true)

const mgmtVlan = ref('90')
const mgmtIp = ref('10.90.')
const mgmtMask = ref('255.255.0.0')
const mgmtGateway = ref('10.90.0.1')

const selectedModelId = ref('RG-S5350-24GT4XS-P-E')
const hardwareOptions = ref([])
const vlanDatabase = ref([])
const selectedVlans = ref([])
const ports = ref([])

const selectedPortIds = ref([])

const configText = ref('')
const loading = ref(false)
const copied = ref(false)
const vlanDropdownOpen = ref(false)

const pairingMode = ref(false)
const sessionId = ref(Math.random().toString(36).substring(2, 10))
const pairingUrl = computed(() => {
  return `${window.location.origin}/scanner.html?session=${sessionId.value}`
})

let socket = null

// Refs for barcodes in print view
const barcodeSn = ref(null)
const barcodeMac = ref(null)
const barcodeInventory = ref(null)

// ── Computed ─────────────────────────────────────────────────
const selectedModel = computed(() =>
  hardwareOptions.value.find((hw) => hw.id === selectedModelId.value)
)

const selectedPortsData = computed(() => {
  return [...selectedPortIds.value]
    .sort((a, b) => a - b)
    .map(id => ports.value.find(p => p.id === id))
    .filter(Boolean)
})

const availableVlans = computed(() =>
  vlanDatabase.value.filter(
    (v) => !selectedVlans.value.some((sv) => sv.id === v.id)
  )
)

const configuredPorts = computed(() => {
  return ports.value.filter((p) => p.configured)
})

const portLayout = computed(() => {
  const model = selectedModel.value
  if (!model) return { groups: [], uplinkGroups: [] }

  const stdPorts = ports.value.filter((p) => !p.isUplink)
  const upPorts = ports.value.filter((p) => p.isUplink)

  const groups = []
  const portsPerGroup = 12

  for (let g = 0; g < stdPorts.length; g += portsPerGroup) {
    const chunk = stdPorts.slice(g, g + portsPerGroup)
    const topRow = []
    const bottomRow = []
    for (let i = 0; i < chunk.length; i++) {
      if (i % 2 === 0) topRow.push(chunk[i])
      else bottomRow.push(chunk[i])
    }
    groups.push({ topRow, bottomRow })
  }

  const uplinkGroups = []
  if (upPorts.length <= 4) {
    uplinkGroups.push({ topRow: upPorts, bottomRow: [] })
  } else {
    const topRow = []
    const bottomRow = []
    for (let i = 0; i < upPorts.length; i++) {
      if (i % 2 === 0) topRow.push(upPorts[i])
      else bottomRow.push(upPorts[i])
    }
    uplinkGroups.push({ topRow, bottomRow })
  }

  return { groups, uplinkGroups }
})

// ── Methods ──────────────────────────────────────────────────
function unlockConfiguration() {
  initError.value = ''
  if (!serialNumber.value.trim()) {
    initError.value = 'Serial Number is required to proceed.'
    return
  }
  isInitialized.value = true
  generatePrintBarcodes()
}

function generatePrintBarcodes() {
  nextTick(() => {
    if (barcodeSn.value && serialNumber.value) {
      JsBarcode(barcodeSn.value, serialNumber.value, { format: 'CODE128', height: 35, displayValue: true, fontSize: 12, margin: 0 })
    }
    if (barcodeMac.value && macAddress.value) {
      JsBarcode(barcodeMac.value, macAddress.value, { format: 'CODE128', height: 35, displayValue: true, fontSize: 12, margin: 0 })
    }
    if (barcodeInventory.value && inventoryTag.value) {
      try {
        bwipjs.toCanvas(barcodeInventory.value, {
            bcid: 'datamatrix',
            text: inventoryTag.value,
            scale: 3,
            height: 10,
            includetext: false,
        });
      } catch (e) {
          console.error("Failed to generate datamatrix", e)
      }
    }
  })
}

function buildPorts() {
  const model = selectedModel.value
  if (!model) { ports.value = []; return }

  const newPorts = []
  for (let i = 1; i <= model.totalPorts; i++) {
    newPorts.push({ 
      id: i, isUplink: false, mode: 'access', vlan: 1, allowed_vlans: 'all', 
      native_vlan: '', description: '', configured: false, poeMode: 'default', poePriority: 'default', poeMaxPower: ''
    })
  }
  for (const portNum of model.uplinkPorts) {
    newPorts.push({ 
      id: portNum, isUplink: true, mode: 'trunk', vlan: 1, allowed_vlans: 'all', 
      native_vlan: '', description: '', configured: false, poeMode: 'default', poePriority: 'default', poeMaxPower: ''
    })
  }
  ports.value = newPorts
  selectedPortIds.value = []
}

function togglePortSelection(port, event) {
  const idx = selectedPortIds.value.indexOf(port.id)
  if (idx > -1) {
    selectedPortIds.value.splice(idx, 1)
  } else {
    selectedPortIds.value.push(port.id)
  }
}

function clearSelection() {
  selectedPortIds.value = []
}

function selectAllUnconfigured() {
  selectedPortIds.value = ports.value.filter(p => !p.configured).map(p => p.id)
}

function getPortName(port) {
  const model = selectedModel.value
  if (!model) return `Port ${port.id}`
  const prefix = port.isUplink ? model.uplinkPrefix : model.portPrefix
  return `${prefix}${port.id}`
}

function addVlan(vlan) {
  if (!selectedVlans.value.some((v) => v.id === vlan.id)) {
    selectedVlans.value.push({ ...vlan })
  }
  vlanDropdownOpen.value = false
}

function removeVlan(index) {
  selectedVlans.value.splice(index, 1)
}

function applyToSelected(field, value) {
  for (const port of selectedPortsData.value) {
    port[field] = value
  }
}

function markConfigured() {
  applyToSelected('configured', true)
}

function markUnconfigured() {
  for (const port of selectedPortsData.value) {
    port.configured = false
    port.mode = port.isUplink ? 'trunk' : 'access'
    port.vlan = 1
    port.allowed_vlans = 'all'
    port.native_vlan = ''
    port.description = ''
    port.poeMode = 'default'
    port.poePriority = 'default'
    port.poeMaxPower = ''
  }
  selectedPortIds.value = []
}

async function generateConfig() {
  if (!hostname.value.trim()) {
    configText.value = '! ERROR: Hostname is required.'
    return
  }
  if (mgmtVlan.value || mgmtIp.value || mgmtMask.value || mgmtGateway.value) {
    if (!mgmtVlan.value || !mgmtIp.value || !mgmtMask.value || !mgmtGateway.value) {
      configText.value = '! ERROR: Management VLAN, IP, Mask, and Gateway must all be provided together.'
      return
    }
  }

  const configured = ports.value.filter(p => p.configured)
  for (const port of configured) {
    if (!port.description || !port.description.trim()) {
      configText.value = `! ERROR: Port ${port.id} is configured but missing a description. A description is mandatory for all enabled ports.`
      return
    }
  }

  loading.value = true
  configText.value = ''
  try {
    const res = await fetch('/api/generate-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serialNumber: serialNumber.value.trim(),
        macAddress: macAddress.value.trim(),
        hostname: hostname.value.trim(),
        enablePassword: enablePassword.value.trim(),
        adminUsername: adminUsername.value.trim(),
        adminPassword: adminPassword.value.trim(),
        enableWeb: enableWeb.value,
        enableSsh: enableSsh.value,
        enableCwmp: enableCwmp.value,
        mgmtVlan: mgmtVlan.value,
        mgmtIp: mgmtIp.value,
        mgmtMask: mgmtMask.value,
        mgmtGateway: mgmtGateway.value,
        modelId: selectedModelId.value,
        vlans: selectedVlans.value,
        ports: ports.value,
      }),
    })
    const data = await res.json()
    configText.value = data.error ? `! ERROR: ${data.error}` : data.configText
    if (!data.error) {
       inventoryTag.value = data.inventoryTag
       generatePrintBarcodes()
       alert("Configuration generated and saved to history successfully!");
    }
  } catch (err) {
    configText.value = `! ERROR: ${err.message}`
  } finally {
    loading.value = false
  }
}

async function copyConfig() {
  if (!configText.value) return
  try {
    await navigator.clipboard.writeText(configText.value)
  } catch {
    const ta = document.querySelector('.config-output')
    if (ta) { ta.select(); document.execCommand('copy') }
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function printSummary() {
  const originalTitle = document.title
  if (hostname.value) {
    document.title = hostname.value
  }
  generatePrintBarcodes()
  setTimeout(() => {
    window.print()
    document.title = originalTitle
  }, 100)
}

function handleClickOutside(e) {
  if (!e.target.closest('.vlan-dropdown-wrapper')) {
    vlanDropdownOpen.value = false
  }
}

watch(selectedModelId, () => buildPorts())

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  try {
    const res = await fetch('/api/setup')
    const data = await res.json()
    hardwareOptions.value = data.hardware || []
    vlanDatabase.value = data.vlans || []
    selectedVlans.value = [...(data.vlans || [])]
    buildPorts()
  } catch (err) {
    console.error('Failed to fetch setup data:', err)
  }

  // Socket.io for mobile scanner
  socket = io(window.location.origin)
  socket.on(`scan_result_${sessionId.value}`, (data) => {
    if (data.type === 'serial') serialNumber.value = data.value
    if (data.type === 'mac') macAddress.value = data.value
  })
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  if (socket) socket.disconnect()
})
</script>

<template>
  <main class="max-w-[1200px] mx-auto px-5 space-y-6">

    <!-- ═══ Initialization Lock Screen ═══ -->
    <div v-if="!isInitialized" class="flex flex-col items-center justify-center min-h-[60vh] print:hidden">
      <Card class="w-full max-w-md shadow-lg border-primary/20">
        <CardHeader class="text-center pb-2">
          <div class="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg class="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"/></svg>
          </div>
          <CardTitle class="text-2xl">Initialize Switch</CardTitle>
          <CardDescription>Enter hardware identifiers to begin provisioning.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4 pt-4">
          <div v-if="initError" class="bg-destructive/15 text-destructive text-sm p-3 rounded-md border border-destructive/30 text-center">
            {{ initError }}
          </div>

          <div class="space-y-2">
            <Label>Serial Number (S/N)</Label>
            <Input v-model="serialNumber" placeholder="Scan or type S/N" autofocus />
          </div>
          <div class="space-y-2">
            <Label>MAC Address <span class="text-muted-foreground font-normal">(Optional)</span></Label>
            <Input v-model="macAddress" placeholder="Scan or type MAC" />
          </div>

          <div class="pt-4 flex flex-col gap-3">
            <Button @click="unlockConfiguration" class="w-full" size="lg">Unlock Configuration</Button>
            
            <div class="relative">
              <div class="absolute inset-0 flex items-center"><span class="w-full border-t"></span></div>
              <div class="relative flex justify-center text-xs uppercase"><span class="bg-card px-2 text-muted-foreground">Or</span></div>
            </div>

            <Button variant="outline" @click="pairingMode = !pairingMode" class="w-full">
              {{ pairingMode ? 'Hide Mobile Scanner Pairing' : '📱 Pair Mobile Scanner' }}
            </Button>
            
            <div v-if="pairingMode" class="flex flex-col items-center p-4 bg-muted/30 rounded-lg border mt-2 animate-in fade-in zoom-in duration-200">
              <p class="text-sm text-center mb-3 text-muted-foreground">Scan this QR with your phone's camera to use it as a barcode scanner.</p>
              <div class="bg-white p-2 rounded-md shadow-sm">
                <qrcode-vue :value="pairingUrl" :size="200" level="M" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- ═══ Main App (Visible after initialization) ═══ -->
    <div v-if="isInitialized" class="space-y-6">
      
      <!-- Current Identity Bar -->
      <div class="flex items-center justify-between bg-primary/10 border border-primary/20 p-3 rounded-lg print:hidden">
        <div class="flex gap-6 text-sm">
          <div><span class="text-muted-foreground font-semibold">S/N:</span> <span class="font-mono">{{ serialNumber }}</span></div>
          <div><span class="text-muted-foreground font-semibold">MAC:</span> <span class="font-mono">{{ macAddress || 'N/A' }}</span></div>
        </div>
        <Button variant="ghost" size="sm" class="h-7 text-xs" @click="isInitialized = false">Change</Button>
      </div>

      <!-- ═══ Global Settings ═══ -->
      <Card class="print:hidden">
        <CardHeader class="pb-3">
          <CardTitle>Global Settings</CardTitle>
          <CardDescription>Configure the device identity and access credentials.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-6">
          <!-- Identity & Auth -->
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="space-y-1.5">
              <Label>Hostname</Label>
              <Input v-model="hostname" placeholder="e.g. CORE-SW-01" />
            </div>
            <div class="space-y-1.5">
              <Label>Hardware Model</Label>
              <Select v-model="selectedModelId">
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="hw in hardwareOptions" :key="hw.id" :value="hw.id">
                    {{ hw.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>Admin Username</Label>
              <Input v-model="adminUsername" placeholder="e.g. admin" />
            </div>
            <div class="space-y-1.5">
              <Label>Admin & Enable Password</Label>
              <div class="flex gap-2">
                <Input v-model="adminPassword" type="password" placeholder="Admin Pass" />
                <Input v-model="enablePassword" type="password" placeholder="Enable Pass" />
              </div>
            </div>
          </div>

          <div class="flex items-center gap-6">
            <div class="flex items-center space-x-2">
              <Checkbox id="enableSsh" v-model="enableSsh" />
              <Label for="enableSsh" class="font-normal cursor-pointer">Enable SSH Service</Label>
            </div>
            <div class="flex items-center space-x-2">
              <Checkbox id="enableWeb" v-model="enableWeb" />
              <Label for="enableWeb" class="font-normal cursor-pointer">Enable Web Management</Label>
            </div>
            <div class="flex items-center space-x-2">
              <Checkbox id="enableCwmp" v-model="enableCwmp" />
              <Label for="enableCwmp" class="font-normal cursor-pointer">CWMP Enabled?</Label>
            </div>
          </div>

          <div class="border-t pt-4">
            <Label class="text-sm font-semibold mb-2 block">Management Network (In-band)</Label>
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div class="space-y-1.5">
                <Label>Management VLAN</Label>
                <Input v-model="mgmtVlan" placeholder="e.g. 99" />
              </div>
              <div class="space-y-1.5">
                <Label>IP Address</Label>
                <Input v-model="mgmtIp" placeholder="e.g. 10.0.99.10" />
              </div>
              <div class="space-y-1.5">
                <Label>Subnet Mask</Label>
                <Input v-model="mgmtMask" placeholder="e.g. 255.255.255.0" />
              </div>
              <div class="space-y-1.5">
                <Label>Default Gateway</Label>
                <Input v-model="mgmtGateway" placeholder="e.g. 10.0.99.1" />
              </div>
            </div>
          </div>

          <div class="border-t pt-4">
            <Label class="mb-2 block font-semibold">VLAN Database</Label>
            <div class="flex flex-wrap items-center gap-2">
              <Badge v-for="(vlan, i) in selectedVlans" :key="vlan.id" variant="secondary" class="gap-1 px-2 py-1">
                <span class="font-mono text-primary">{{ vlan.id }}</span>
                <span>{{ vlan.name }}</span>
                <span class="cursor-pointer text-muted-foreground hover:text-destructive ml-1" @click="removeVlan(i)">✕</span>
              </Badge>

              <div class="vlan-dropdown-wrapper relative inline-block">
                <Button variant="outline" size="sm" class="h-7 text-xs" @click.stop="vlanDropdownOpen = !vlanDropdownOpen" :disabled="availableVlans.length === 0">
                  + Add VLAN
                </Button>
                <div v-if="vlanDropdownOpen && availableVlans.length > 0" class="vlan-dropdown">
                  <button v-for="vlan in availableVlans" :key="vlan.id" class="vlan-dropdown-item" @click="addVlan(vlan)">
                    <span class="item-id">{{ vlan.id }}</span>
                    <span>{{ vlan.name }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- ═══ Switch Face + Port Config ═══ -->
      <div class="space-y-6 print:hidden">
        <!-- Switch Face (Same logic as original) -->
        <Card>
          <CardHeader class="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle>{{ selectedModelId }}</CardTitle>
              <CardDescription>Click to select ports</CardDescription>
            </div>
            <div class="flex items-center gap-3 text-[10px] text-muted-foreground select-none">
              <span class="flex items-center gap-1"><span class="legend-dot bg-cyan-500/20 border-cyan-500/50 border"></span>Access</span>
              <span class="flex items-center gap-1"><span class="legend-dot bg-amber-500/20 border-amber-500/50 border"></span>Trunk</span>
              <span class="flex items-center gap-1"><span class="legend-dot bg-muted border-border border"></span>Unconfigured</span>
            </div>
          </CardHeader>
          <CardContent>
            <ScrollArea class="w-full">
              <div class="switch-chassis min-w-max pb-2">
                <div class="flex items-center">
                  <!-- Standard port groups -->
                  <template v-for="(group, gi) in portLayout.groups" :key="'g-' + gi">
                    <div class="port-group">
                      <div class="port-row">
                        <div v-for="port in group.topRow" :key="'t-' + port.id" class="port-cell" :class="[!port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'), selectedPortIds.includes(port.id) ? 'port-selected' : '']" @click="togglePortSelection(port, $event)">
                          {{ port.id }}<span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                      <div class="port-row">
                        <div v-for="port in group.bottomRow" :key="'b-' + port.id" class="port-cell" :class="[!port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'), selectedPortIds.includes(port.id) ? 'port-selected' : '']" @click="togglePortSelection(port, $event)">
                          {{ port.id }}<span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                  <!-- Divider -->
                  <div v-if="portLayout.uplinkGroups.length" class="chassis-divider"></div>
                  <!-- Uplink port groups -->
                  <template v-for="(group, ui) in portLayout.uplinkGroups" :key="'u-' + ui">
                    <div class="port-group">
                      <div class="port-row">
                        <div v-for="port in group.topRow" :key="'ut-' + port.id" class="port-cell port-uplink" :class="[!port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'), selectedPortIds.includes(port.id) ? 'port-selected' : '']" @click="togglePortSelection(port, $event)">
                          {{ port.id }}<span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                      <div v-if="group.bottomRow.length" class="port-row">
                        <div v-for="port in group.bottomRow" :key="'ub-' + port.id" class="port-cell port-uplink" :class="[!port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'), selectedPortIds.includes(port.id) ? 'port-selected' : '']" @click="togglePortSelection(port, $event)">
                          {{ port.id }}<span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
            <div class="mt-4 flex gap-2">
              <Button variant="outline" size="sm" @click="selectAllUnconfigured">Select All Unconfigured</Button>
              <Button variant="outline" size="sm" @click="clearSelection" v-if="selectedPortIds.length > 0">Clear Selection</Button>
            </div>
          </CardContent>
        </Card>

        <!-- Port Config Panel (Same logic as original) -->
        <Card>
          <CardHeader class="pb-3"><CardTitle>Port Config</CardTitle></CardHeader>
          <CardContent>
            <div v-if="selectedPortsData.length > 0" class="space-y-4 animate-in slide-in-from-bottom-2 fade-in duration-200">
              <div class="bg-muted/50 border rounded-md p-3">
                <p class="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Editing {{ selectedPortIds.length }} Port(s)</p>
                <div class="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
                  <Badge variant="outline" v-for="port in selectedPortsData" :key="port.id" class="text-[10px] font-mono">{{ port.id }}</Badge>
                </div>
              </div>

              <div v-if="selectedPortsData.some(p => !p.configured)">
                <Button class="w-full" @click="markConfigured">Enable Configuration</Button>
                <p class="text-xs text-muted-foreground mt-2 text-center">Click to configure selected ports</p>
              </div>

              <template v-if="selectedPortsData.every(p => p.configured)">
                <div class="space-y-1.5">
                  <Label>Description</Label>
                  <Input :model-value="selectedPortsData[0].description" @update:model-value="val => applyToSelected('description', val)" placeholder="e.g. Uplink to Core" />
                </div>
                <div class="space-y-1.5">
                  <Label>Mode</Label>
                  <div class="flex bg-muted rounded-md p-1 border">
                    <button class="flex-1 text-xs py-1.5 rounded-sm font-medium transition-colors" :class="selectedPortsData[0].mode === 'access' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="applyToSelected('mode', 'access')">Access</button>
                    <button class="flex-1 text-xs py-1.5 rounded-sm font-medium transition-colors" :class="selectedPortsData[0].mode === 'trunk' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="applyToSelected('mode', 'trunk')">Trunk</button>
                  </div>
                </div>
                <div v-if="selectedPortsData[0].mode === 'access'" class="space-y-1.5">
                  <Label>Access VLAN ID</Label>
                  <Input :model-value="selectedPortsData[0].vlan" @update:model-value="val => applyToSelected('vlan', val)" type="number" min="1" max="4094" />
                </div>
                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Allowed Trunk VLANs</Label>
                  <Input :model-value="selectedPortsData[0].allowed_vlans" @update:model-value="val => applyToSelected('allowed_vlans', val)" placeholder="all, or 10,20,30" />
                </div>
                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Native VLAN (Optional)</Label>
                  <Input :model-value="selectedPortsData[0].native_vlan" @update:model-value="val => applyToSelected('native_vlan', val)" placeholder="e.g. 99" type="number" min="1" max="4094" />
                </div>
                <div class="pt-2">
                  <Button variant="destructive" size="sm" class="w-full" @click="markUnconfigured">Remove Configuration</Button>
                </div>
              </template>
            </div>
            <div v-else class="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <svg class="w-8 h-8 mb-2 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>
              <p class="text-xs">Click ports to configure</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- ═══ Generate & Output ═══ -->
      <Card class="print:hidden">
        <CardContent class="p-0">
          <Tabs defaultValue="cli" class="w-full">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border-b gap-4">
              <TabsList>
                <TabsTrigger value="cli">CLI Configuration</TabsTrigger>
                <TabsTrigger value="summary">Summary View</TabsTrigger>
              </TabsList>
              <div class="flex gap-2">
                <Button v-if="configText" variant="outline" @click="copyConfig">
                  {{ copied ? '✓ Copied' : '📋 Copy CLI' }}
                </Button>
                <Button variant="outline" @click="printSummary">🖨️ Print Summary</Button>
                <Button :disabled="loading || !hostname.trim()" @click="generateConfig">
                  {{ loading ? 'Saving & Generating…' : 'Generate & Save' }}
                </Button>
              </div>
            </div>
            <TabsContent value="cli" class="p-4 m-0 border-none outline-none">
              <textarea v-model="configText" class="w-full bg-slate-950 text-emerald-400 font-mono text-sm p-4 rounded-md border resize-y min-h-[300px] focus:outline-none focus:ring-2 focus:ring-primary" readonly placeholder="Click 'Generate & Save' to generate the CLI output and save to History..."></textarea>
            </TabsContent>
            <TabsContent value="summary" class="p-4 m-0 border-none outline-none">
              <div class="bg-background border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Interface</TableHead><TableHead>Description</TableHead><TableHead>Mode</TableHead><TableHead>VLANs</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="port in configuredPorts" :key="port.id">
                      <TableCell class="font-mono font-medium">{{ getPortName(port) }}</TableCell>
                      <TableCell>{{ port.description || '-' }}</TableCell>
                      <TableCell><Badge :variant="port.mode === 'access' ? 'default' : 'secondary'">{{ port.mode }}</Badge></TableCell>
                      <TableCell>{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</TableCell>
                    </TableRow>
                    <TableRow v-if="configuredPorts.length === 0">
                      <TableCell colspan="4" class="text-center py-10 text-muted-foreground">No ports configured. Click a port in the chassis above to configure it.</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <!-- ═══ Print Only Summary ═══ -->
      <div class="hidden print:block space-y-6 text-black bg-white min-h-screen">
        <div class="border-b pb-6">
          <h2 class="text-3xl font-bold mb-4 border-b pb-2">Switch {{ hostname || 'Unknown' }} Provisioning Summary</h2>
          <div class="grid grid-cols-2 gap-6 text-sm">
            <div class="space-y-2">
              <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Identity</h3>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Hostname:</span> {{ hostname || 'Not set' }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Hardware Model:</span> {{ selectedModelId }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Serial Number:</span> {{ serialNumber }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">MAC Address:</span> {{ macAddress || 'N/A' }}</div>
            </div>
            
            <div class="space-y-2">
              <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Services & Management</h3>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">SSH Service:</span> {{ enableSsh ? 'Enabled' : 'Disabled' }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Web Management:</span> {{ enableWeb ? 'Enabled' : 'Disabled' }}</div>
              <div v-if="mgmtIp"><span class="font-semibold text-slate-500 w-32 inline-block">Management IP:</span> {{ mgmtIp }} (VLAN {{ mgmtVlan }})</div>
              
              <div v-if="inventoryTag" class="mt-4 border p-2 rounded-md inline-flex items-center gap-4 bg-slate-50">
                <canvas ref="barcodeInventory"></canvas>
                <div>
                  <div class="text-[10px] text-slate-500 font-semibold uppercase">Inventory Tag</div>
                  <div class="font-mono font-bold">{{ inventoryTag }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-lg text-slate-700 border-b pb-1 mb-4 mt-2">Hardware Identifiers</h3>
          <div class="flex gap-4">
            <div class="border p-2 rounded-md bg-slate-50 text-center inline-block min-w-[280px]">
              <div class="text-[10px] text-slate-500 mb-1 font-semibold uppercase">Serial Number</div>
              <svg ref="barcodeSn" class="w-full h-[50px] mx-auto"></svg>
            </div>
            <div v-if="macAddress" class="border p-2 rounded-md bg-slate-50 text-center inline-block min-w-[280px]">
              <div class="text-[10px] text-slate-500 mb-1 font-semibold uppercase">MAC Address</div>
              <svg ref="barcodeMac" class="w-full h-[50px] mx-auto"></svg>
            </div>
            <div v-else class="border p-2 rounded-md bg-slate-50 flex items-center justify-center min-w-[280px]">
              <div class="text-slate-400 italic">No MAC Address Provided</div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="text-xl font-bold mb-3 text-slate-800">VLAN Database</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="vlan in selectedVlans" :key="vlan.id" class="border border-slate-300 rounded px-2 py-1 text-sm bg-slate-50">
              <strong class="text-slate-600 mr-2">{{ vlan.id }}</strong> {{ vlan.name }}
            </span>
          </div>
        </div>

        <div class="print:break-before-page print:pt-4">
          <h3 class="text-xl font-bold mb-3 text-slate-800 mt-6">Standard Port Configurations</h3>
          <table class="w-full text-sm text-left border-collapse border border-slate-300">
            <thead>
              <tr class="bg-slate-100 text-slate-700">
                <th class="border border-slate-300 p-2">Interface</th>
                <th class="border border-slate-300 p-2">Description</th>
                <th class="border border-slate-300 p-2">Mode</th>
                <th class="border border-slate-300 p-2">VLANs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="port in configuredPorts.filter(p => !p.isUplink)" :key="port.id">
                <td class="border border-slate-300 p-2 font-mono text-xs">{{ getPortName(port) }}</td>
                <td class="border border-slate-300 p-2">{{ port.description || '-' }}</td>
                <td class="border border-slate-300 p-2"><span class="uppercase text-[10px] tracking-wider font-bold text-slate-500">{{ port.mode }}</span></td>
                <td class="border border-slate-300 p-2">{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</td>
              </tr>
              <tr v-if="configuredPorts.filter(p => !p.isUplink).length === 0">
                <td colspan="4" class="border border-slate-300 p-6 text-center italic text-slate-500">
                  No standard ports configured.
                </td>
              </tr>
            </tbody>
          </table>

          <h3 class="text-xl font-bold mb-3 text-slate-800 mt-8">Uplink Port Configurations (SFP)</h3>
          <table class="w-full text-sm text-left border-collapse border border-slate-300">
            <thead>
              <tr class="bg-slate-100 text-slate-700">
                <th class="border border-slate-300 p-2">Interface</th>
                <th class="border border-slate-300 p-2">Description</th>
                <th class="border border-slate-300 p-2">Mode</th>
                <th class="border border-slate-300 p-2">VLANs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="port in configuredPorts.filter(p => p.isUplink)" :key="port.id">
                <td class="border border-slate-300 p-2 font-mono text-xs">{{ getPortName(port) }}</td>
                <td class="border border-slate-300 p-2">{{ port.description || '-' }}</td>
                <td class="border border-slate-300 p-2"><span class="uppercase text-[10px] tracking-wider font-bold text-slate-500">{{ port.mode }}</span></td>
                <td class="border border-slate-300 p-2">{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</td>
              </tr>
              <tr v-if="configuredPorts.filter(p => p.isUplink).length === 0">
                <td colspan="4" class="border border-slate-300 p-6 text-center italic text-slate-500">
                  No uplink ports configured.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
/* Swtich Chassis Styles */
.switch-chassis {
  background: linear-gradient(180deg, hsl(var(--muted)) 0%, hsl(var(--background)) 100%);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  padding: 14px 16px;
  position: relative;
}
.switch-chassis::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, hsl(var(--primary)) 0%, #06b6d4 50%, #14b8a6 100%);
  opacity: 0.8;
  border-radius: var(--radius) var(--radius) 0 0;
}
.port-cell {
  width: 34px; height: 26px; border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 600; font-family: var(--font-mono);
  cursor: pointer; border: 1.5px solid transparent;
  transition: all 0.12s ease; position: relative; user-select: none; flex-shrink: 0;
}
.port-cell:hover { transform: scale(1.15); z-index: 10; }
.port-cell:active { transform: scale(0.92); }
.port-unconfigured { background: hsl(var(--muted)); border-color: hsl(var(--border)); color: hsl(var(--muted-foreground)); }
.port-access { background: rgba(6, 182, 212, 0.15); border-color: rgba(6, 182, 212, 0.4); color: #06b6d4; }
.port-trunk { background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.4); color: #f59e0b; }
.port-selected { border-color: hsl(var(--primary)) !important; box-shadow: 0 0 0 2px rgba(var(--primary), 0.3), 0 0 10px -2px rgba(var(--primary), 0.4) !important; transform: scale(1.15); z-index: 10; }
.port-uplink { border-style: dashed; width: 38px; height: 26px; }
.port-group { display: inline-flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
.port-row { display: flex; gap: 2px; }
.port-group + .port-group { margin-left: 8px; }
.chassis-divider { width: 1px; align-self: stretch; background: hsl(var(--border)); margin: 0 10px; flex-shrink: 0; }
.legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.port-tooltip { position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%); background: hsl(var(--popover)); border: 1px solid hsl(var(--border)); color: hsl(var(--popover-foreground)); padding: 2px 7px; border-radius: 4px; font-size: 9px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.1s; z-index: 50; font-family: var(--font-mono); }
.port-cell:hover .port-tooltip { opacity: 1; }

.vlan-dropdown { position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; min-width: 220px; max-height: 200px; overflow-y: auto; border-radius: var(--radius); border: 1px solid hsl(var(--border)); background: hsl(var(--popover)); box-shadow: 0 8px 30px -8px rgba(0, 0, 0, 0.5); padding: 4px; }
.vlan-dropdown-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; border: none; background: transparent; border-radius: calc(var(--radius) - 2px); font-size: 13px; color: hsl(var(--popover-foreground)); cursor: pointer; }
.vlan-dropdown-item:hover { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.item-id { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: hsl(var(--primary)); min-width: 28px; }
</style>
