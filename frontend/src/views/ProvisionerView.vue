<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import JsBarcode from 'jsbarcode'
import bwipjs from 'bwip-js'

const route = useRoute()
const router = useRouter()

// Import Shadcn UI Components
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import LabelPrinterModal from '@/components/LabelPrinterModal.vue'
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
const editingDeploymentId = ref(null)
const isLoadingDeployment = ref(false)
const serialNumber = ref('')
const macAddress = ref('')
const initError = ref('')

const inventoryTag = ref('')
const hostname = ref('')
const adminUsername = ref('admin')
const adminPassword = ref('')
const confirmPassword = ref('')
const enableSsh = ref(true)
const enableWeb = ref(true)
const enableCwmp = ref(true)

const selectedTimezone = ref('WIB 7 0')
const ntpServers = ref('0.id.pool.ntp.org, 1.id.pool.ntp.org')

const mgmtVlan = ref('90')
const mgmtIp = ref('10.90.')
const mgmtMask = ref('255.255.0.0')
const mgmtGateway = ref('10.90.0.1')

const selectedModelId = ref('RG-S5350-24GT4XS-P-E')
const hardwareOptions = ref([])
const vlanDatabase = ref([])
const portProfiles = ref([])
const selectedVlans = ref([])
const ports = ref([])

const selectedPortIds = ref([])

const configText = ref('')
const loading = ref(false)
const copied = ref(false)
const vlanDropdownOpen = ref(false)
const showPrintLabelModal = ref(false)

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

const stdPorts = computed(() => ports.value.filter((p) => !p.isUplink))
const uplinkPortsList = computed(() => ports.value.filter((p) => p.isUplink))
const halfStdPortsCount = computed(() => Math.ceil(stdPorts.value.length / 2))

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

function selectFirstHalf() {
  const std = stdPorts.value
  const half = Math.ceil(std.length / 2)
  selectedPortIds.value = std.slice(0, half).map(p => p.id)
}

function selectSecondHalf() {
  const std = stdPorts.value
  const half = Math.ceil(std.length / 2)
  selectedPortIds.value = std.slice(half).map(p => p.id)
}

function selectAllUplinks() {
  selectedPortIds.value = uplinkPortsList.value.map(p => p.id)
}

function ensureVlanInSelected(vlanId, defaultName) {
  if (!selectedVlans.value.some(v => Number(v.id) === Number(vlanId))) {
    const fromDb = vlanDatabase.value.find(v => Number(v.id) === Number(vlanId))
    if (fromDb) {
      selectedVlans.value.push({ ...fromDb })
    } else {
      selectedVlans.value.push({ id: Number(vlanId), name: defaultName })
    }
  }
}

function applyProfile(profile) {
  if (profile.mode === 'access' && profile.vlan) {
    ensureVlanInSelected(profile.vlan, `VLAN ${profile.vlan}`)
  } else if (profile.mode === 'trunk') {
    if (profile.native_vlan) {
      ensureVlanInSelected(profile.native_vlan, `VLAN ${profile.native_vlan}`)
    }
    if (profile.allowed_vlans && profile.allowed_vlans !== 'all') {
      const vlans = profile.allowed_vlans.split(',').map(v => v.trim())
      for (const v of vlans) {
        if (v && !isNaN(Number(v))) {
          ensureVlanInSelected(v, `VLAN ${v}`)
        }
      }
    }
  }

  for (const port of selectedPortsData.value) {
    port.configured = true
    port.mode = profile.mode || 'access'
    if (port.mode === 'access') {
      port.vlan = profile.vlan || '1'
    } else {
      port.allowed_vlans = profile.allowed_vlans || 'all'
      port.native_vlan = profile.native_vlan || ''
    }
    port.description = profile.description || ''
    port.poeMode = profile.poeMode || 'default'
    port.poePriority = profile.poePriority || 'default'
    port.poeMaxPower = profile.poeMaxPower || ''
  }
}

function handleVlanInput(field, val) {
  let clean = String(val).replace(/\D/g, '')
  if (clean !== '') {
    const num = parseInt(clean, 10)
    if (num > 4094) clean = '4094'
  }
  applyToSelected(field, clean)
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
  if (adminPassword.value !== confirmPassword.value) {
    configText.value = '! ERROR: Passwords do not match. Please ensure Password and Confirm Password match.'
    return
  }
  if (mgmtVlan.value || mgmtIp.value || mgmtMask.value || mgmtGateway.value) {
    if (!mgmtVlan.value || !mgmtIp.value || !mgmtMask.value || !mgmtGateway.value) {
      configText.value = '! ERROR: Management VLAN, IP, Mask, and Gateway must all be provided together.'
      return
    }
    const mv = parseInt(mgmtVlan.value, 10)
    if (isNaN(mv) || mv < 1 || mv > 4094) {
      configText.value = `! ERROR: Management VLAN must be between 1 and 4094.`
      return
    }
  }

  const configured = ports.value.filter(p => p.configured)
  for (const port of configured) {
    if (!port.description || !port.description.trim()) {
      configText.value = `! ERROR: Port ${port.id} is configured but missing a description. A description is mandatory for all enabled ports.`
      return
    }
    if (port.mode === 'access') {
      const v = parseInt(port.vlan, 10)
      if (isNaN(v) || v < 1 || v > 4094) {
        configText.value = `! ERROR: Port ${port.id} has invalid Access VLAN: "${port.vlan}". Must be between 1 and 4094.`
        return
      }
    }
    if (port.mode === 'trunk' && port.native_vlan) {
      const nv = parseInt(port.native_vlan, 10)
      if (isNaN(nv) || nv < 1 || nv > 4094) {
        configText.value = `! ERROR: Port ${port.id} has invalid Native VLAN: "${port.native_vlan}". Must be between 1 and 4094.`
        return
      }
    }
  }

  loading.value = true
  configText.value = ''
  try {
    const res = await fetch('/api/generate-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        editingDeploymentId: editingDeploymentId.value,
        serialNumber: serialNumber.value.trim(),
        macAddress: macAddress.value.trim(),
        hostname: hostname.value.trim(),
        enablePassword: adminPassword.value.trim(),
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
        timezone: selectedTimezone.value,
        ntpServers: ntpServers.value,
        vlans: selectedVlans.value,
        ports: ports.value,
      }),
    })
    const data = await res.json()
    configText.value = data.error ? `! ERROR: ${data.error}` : data.configText
    if (!data.error) {
       inventoryTag.value = data.inventoryTag
       generatePrintBarcodes()
       alert(editingDeploymentId.value ? "Deployment configuration updated successfully!" : "Configuration generated and saved to history successfully!");
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

function focusMacInput() {
  const el = document.getElementById('mac-input')
  if (el) el.focus()
}

watch(macAddress, (newVal) => {
  if (!newVal) return

  // Strip anything that isn't a hex character
  let clean = newVal.replace(/[^0-9A-Fa-f]/g, '').toUpperCase()
  
  // Truncate to maximum 12 hex characters (standard MAC size)
  if (clean.length > 12) {
    clean = clean.substring(0, 12)
  }

  // Insert colons every two characters
  const formatted = clean.match(/.{1,2}/g)?.join(':') || ''
  
  // Only update if it actually changed to avoid infinite loop
  if (macAddress.value !== formatted) {
    macAddress.value = formatted
  }
})

function handleClickOutside(e) {
  if (!e.target.closest('.vlan-dropdown-wrapper')) {
    vlanDropdownOpen.value = false
  }
}

async function loadDeploymentForEdit(id) {
  isLoadingDeployment.value = true
  try {
    const res = await fetch(`/api/deployments/${id}`, { credentials: 'include' })
    if (!res.ok) {
      alert('Deployment not found.')
      return
    }
    const dep = await res.json()
    editingDeploymentId.value = dep.id
    serialNumber.value = dep.serial_number || ''
    macAddress.value = dep.mac_address || ''
    inventoryTag.value = dep.inventory_tag || ''
    selectedModelId.value = dep.model_id

    const payload = JSON.parse(dep.config_payload || '{}')
    hostname.value = payload.hostname || dep.hostname || ''
    adminUsername.value = payload.adminUsername || 'admin'
    adminPassword.value = payload.adminPassword || payload.enablePassword || ''
    confirmPassword.value = payload.adminPassword || payload.enablePassword || ''
    enableSsh.value = payload.enableSsh ?? true
    enableWeb.value = payload.enableWeb ?? true
    enableCwmp.value = payload.enableCwmp ?? true
    mgmtVlan.value = payload.mgmtVlan || '90'
    mgmtIp.value = payload.mgmtIp || dep.mgmt_ip || '10.90.'
    mgmtMask.value = payload.mgmtMask || '255.255.0.0'
    mgmtGateway.value = payload.mgmtGateway || '10.90.0.1'

    selectedTimezone.value = payload.timezone || 'WIB 7 0'
    if (payload.ntpServers) {
      ntpServers.value = Array.isArray(payload.ntpServers) ? payload.ntpServers.join(', ') : payload.ntpServers
    } else {
      ntpServers.value = '0.id.pool.ntp.org, 1.id.pool.ntp.org'
    }

    if (payload.vlans && Array.isArray(payload.vlans)) {
      selectedVlans.value = payload.vlans
    }
    if (payload.ports && Array.isArray(payload.ports)) {
      ports.value = payload.ports
    }
    configText.value = dep.generated_cli || ''
    isInitialized.value = true
  } catch (err) {
    console.error('Failed to load deployment for editing', err)
  } finally {
    isLoadingDeployment.value = false
  }
}

function exitEditMode() {
  editingDeploymentId.value = null
  router.replace({ path: '/' })
  isInitialized.value = false
  serialNumber.value = ''
  macAddress.value = ''
  inventoryTag.value = ''
  hostname.value = ''
  adminPassword.value = ''
  confirmPassword.value = ''
  selectedTimezone.value = 'WIB 7 0'
  ntpServers.value = '0.id.pool.ntp.org, 1.id.pool.ntp.org'
  configText.value = ''
  buildPorts()
}

watch(selectedModelId, () => {
  if (!isLoadingDeployment.value) buildPorts()
})

watch(() => route.query.edit, (newId) => {
  if (newId) {
    loadDeploymentForEdit(newId)
  }
})

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  try {
    const res = await fetch('/api/setup', { credentials: 'include' })
    const data = await res.json()
    hardwareOptions.value = data.hardware || []
    vlanDatabase.value = data.vlans || []
    portProfiles.value = data.portProfiles || []
    selectedVlans.value = [...(data.vlans || [])]
    buildPorts()
    if (route.query.edit) {
      await loadDeploymentForEdit(route.query.edit)
    }
  } catch (err) {
    console.error('Failed to fetch setup data:', err)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
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
            <Input id="sn-input" v-model="serialNumber" placeholder="Scan or type S/N" autofocus @keydown.enter="focusMacInput" />
          </div>
          <div class="space-y-2">
            <Label>MAC Address <span class="text-muted-foreground font-normal">(Optional)</span></Label>
            <Input id="mac-input" v-model="macAddress" placeholder="Scan or type MAC" @keydown.enter="unlockConfiguration" />
          </div>

          <div class="pt-4 flex flex-col gap-3">
            <Button @click="unlockConfiguration" class="w-full" size="lg">Unlock Configuration</Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- ═══ Main App (Visible after initialization) ═══ -->
    <div v-if="isInitialized" class="space-y-6">
      
      <!-- Reconfiguring Alert Bar -->
      <div v-if="editingDeploymentId" class="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-amber-500/10 border border-amber-500/30 p-3 rounded-lg gap-2 print:hidden">
        <div class="flex items-center gap-2 text-sm text-amber-500 font-medium">
          <span class="text-base">🛠️</span>
          <span>Reconfiguring Deployment #{{ editingDeploymentId }} — <strong>{{ hostname || 'Switch' }}</strong> (S/N: {{ serialNumber }})</span>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs border-amber-500/40 text-amber-500 hover:bg-amber-500/10" @click="exitEditMode">Exit Reconfigure Mode</Button>
        </div>
      </div>

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
              <Label>Password (Plain Text)</Label>
              <div class="flex gap-2">
                <Input v-model="adminPassword" type="text" placeholder="Password" />
                <Input v-model="confirmPassword" type="text" placeholder="Confirm Password" />
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
            <Label class="text-sm font-semibold mb-2 block">Time & Network Time Protocol (NTP)</Label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <Label>Timezone</Label>
                <Select v-model="selectedTimezone">
                  <SelectTrigger>
                    <SelectValue placeholder="Select Timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WIB 7 0">WIB - Western Indonesia (UTC+7)</SelectItem>
                    <SelectItem value="WITA 8 0">WITA - Central Indonesia (UTC+8)</SelectItem>
                    <SelectItem value="WIT 9 0">WIT - Eastern Indonesia (UTC+9)</SelectItem>
                    <SelectItem value="UTC 0 0">UTC (UTC+0)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="space-y-1.5">
                <Label>NTP Server(s) <span class="text-muted-foreground text-xs font-normal">(comma-separated)</span></Label>
                <Input v-model="ntpServers" placeholder="e.g. 0.id.pool.ntp.org, 1.id.pool.ntp.org" />
              </div>
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
            <div class="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" @click="selectAllUnconfigured">Select All Unconfigured</Button>
              <Button variant="outline" size="sm" @click="selectFirstHalf" v-if="stdPorts.length > 0">Select 1st Half (1-{{ halfStdPortsCount }})</Button>
              <Button variant="outline" size="sm" @click="selectSecondHalf" v-if="stdPorts.length > 0">Select 2nd Half ({{ halfStdPortsCount + 1 }}-{{ stdPorts.length }})</Button>
              <Button variant="outline" size="sm" @click="selectAllUplinks" v-if="uplinkPortsList.length > 0">Select All Uplinks</Button>
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

              <!-- Port Profiles (Presets) -->
              <div class="space-y-1.5 bg-muted/40 border rounded-md p-2.5" v-if="portProfiles.length > 0">
                <p class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Port Profiles</p>
                <div class="grid grid-cols-2 gap-2">
                  <Button 
                    v-for="profile in portProfiles" 
                    :key="profile.id"
                    variant="secondary" 
                    size="sm" 
                    class="text-xs h-8 font-medium justify-center" 
                    @click="applyProfile(profile)"
                    :title="profile.description || profile.name"
                  >
                    {{ profile.name }}
                  </Button>
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
                  <Input :model-value="String(selectedPortsData[0].vlan || '')" @update:model-value="val => handleVlanInput('vlan', val)" type="text" placeholder="1-4094" />
                </div>
                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Allowed Trunk VLANs</Label>
                  <Input :model-value="selectedPortsData[0].allowed_vlans" @update:model-value="val => applyToSelected('allowed_vlans', val)" placeholder="all, or 10,20,30" />
                </div>
                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Native VLAN (Optional)</Label>
                  <Input :model-value="String(selectedPortsData[0].native_vlan || '')" @update:model-value="val => handleVlanInput('native_vlan', val)" placeholder="e.g. 99" type="text" />
                </div>
                
                <!-- PoE Configuration -->
                <div class="space-y-1.5 pt-2 border-t mt-2">
                  <Label>Power over Ethernet (PoE)</Label>
                  <Select :model-value="selectedPortsData[0].poeMode || 'default'" @update:model-value="val => applyToSelected('poeMode', val)">
                    <SelectTrigger class="h-8 text-xs">
                      <SelectValue placeholder="PoE Mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default (Enabled)</SelectItem>
                      <SelectItem value="enabled">Force Enabled</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div v-if="selectedPortsData[0].poeMode && selectedPortsData[0].poeMode !== 'disabled'" class="grid grid-cols-2 gap-2">
                  <div class="space-y-1.5">
                    <Label class="text-xs">PoE Priority</Label>
                    <Select :model-value="selectedPortsData[0].poePriority || 'default'" @update:model-value="val => applyToSelected('poePriority', val)">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue placeholder="Priority" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default (Low)</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-1.5">
                    <Label class="text-xs">Max Power (mW)</Label>
                    <Input :model-value="selectedPortsData[0].poeMaxPower || ''" @update:model-value="val => applyToSelected('poeMaxPower', val)" placeholder="e.g. 30000" class="h-8 text-xs" />
                  </div>
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
                <Button variant="outline" @click="showPrintLabelModal = true">🏷️ Print Label</Button>
                <Button variant="outline" @click="printSummary">🖨️ Print Summary</Button>
                <Button :disabled="loading || !hostname.trim()" @click="generateConfig">
                  {{ loading ? 'Saving & Generating…' : (editingDeploymentId ? '💾 Update Configuration' : 'Generate & Save') }}
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
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Timezone:</span> {{ selectedTimezone }}</div>
              <div v-if="ntpServers"><span class="font-semibold text-slate-500 w-32 inline-block">NTP Servers:</span> {{ ntpServers }}</div>
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
    <LabelPrinterModal
      v-model:open="showPrintLabelModal"
      :hostname="hostname"
      :inventoryTag="inventoryTag"
      :managementIp="mgmtIp"
      :serialNumber="serialNumber"
      :macAddress="macAddress"
    />
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
