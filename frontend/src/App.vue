<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

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

// Computed list of only configured ports
const configuredPorts = computed(() => {
  return ports.value.filter((p) => p.configured)
})

// ── Port layout: realistic 1U switch face ────────────────────
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
function buildPorts() {
  const model = selectedModel.value
  if (!model) { ports.value = []; return }

  const newPorts = []
  for (let i = 1; i <= model.totalPorts; i++) {
    newPorts.push({ 
      id: i, 
      isUplink: false, 
      mode: 'access', 
      vlan: 1, 
      allowed_vlans: 'all', 
      native_vlan: '', 
      description: '', 
      configured: false,
      poeMode: 'default',
      poePriority: 'default',
      poeMaxPower: ''
    })
  }
  for (const portNum of model.uplinkPorts) {
    newPorts.push({ 
      id: portNum, 
      isUplink: true, 
      mode: 'trunk', 
      vlan: 1, 
      allowed_vlans: 'all', 
      native_vlan: '', 
      description: '', 
      configured: false,
      poeMode: 'default',
      poePriority: 'default',
      poeMaxPower: ''
    })
  }
  ports.value = newPorts
  selectedPortIds.value = []
}

function togglePortSelection(port, event) {
  // If Shift is pressed, maybe clear and select? For now, we just toggle.
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

  // Validate IPs if any mgmt field is provided
  if (mgmtVlan.value || mgmtIp.value || mgmtMask.value || mgmtGateway.value) {
    if (!mgmtVlan.value || !mgmtIp.value || !mgmtMask.value || !mgmtGateway.value) {
      configText.value = '! ERROR: Management VLAN, IP, Mask, and Gateway must all be provided together.'
      return
    }
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
    if (!ipRegex.test(mgmtIp.value) || !ipRegex.test(mgmtMask.value) || !ipRegex.test(mgmtGateway.value)) {
      configText.value = '! ERROR: Invalid IP address format in Management Network settings.'
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
        ports: ports.value, // Backend will filter out unconfigured ports
      }),
    })
    const data = await res.json()
    configText.value = data.error ? `! ERROR: ${data.error}` : data.configText
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
  window.print()
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
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="min-h-screen bg-background text-foreground pb-10 print:bg-white print:text-black">
    <!-- ═══ Header ═══ -->
    <header class="border-b px-5 py-4 mb-6 print:hidden">
      <div class="max-w-[1200px] mx-auto flex items-center gap-3">
        <div class="w-8 h-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold text-xs shadow-md">
          SW
        </div>
        <div class="leading-tight">
          <h1 class="text-base font-semibold">Visual Switch Provisioner</h1>
          <p class="text-xs text-muted-foreground">Ruijie CLI Configuration Generator</p>
        </div>
      </div>
    </header>

    <main class="max-w-[1200px] mx-auto px-5 space-y-6">

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

              <!-- Dropdown wrapper -->
              <div class="vlan-dropdown-wrapper relative inline-block">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 text-xs"
                  @click.stop="vlanDropdownOpen = !vlanDropdownOpen"
                  :disabled="availableVlans.length === 0"
                >+ Add VLAN</Button>
                <div v-if="vlanDropdownOpen && availableVlans.length > 0" class="vlan-dropdown">
                  <button
                    v-for="vlan in availableVlans"
                    :key="vlan.id"
                    class="vlan-dropdown-item"
                    @click="addVlan(vlan)"
                  >
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

        <!-- Switch Face -->
        <Card>
          <CardHeader class="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle>{{ selectedModelId }}</CardTitle>
              <CardDescription>Click to select ports</CardDescription>
            </div>
            <div class="flex items-center gap-3 text-[10px] text-muted-foreground select-none">
              <span class="flex items-center gap-1">
                <span class="legend-dot bg-cyan-500/20 border-cyan-500/50 border"></span>
                Access
              </span>
              <span class="flex items-center gap-1">
                <span class="legend-dot bg-amber-500/20 border-amber-500/50 border"></span>
                Trunk
              </span>
              <span class="flex items-center gap-1">
                <span class="legend-dot bg-muted border-border border"></span>
                Unconfigured
              </span>
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
                        <div
                          v-for="port in group.topRow"
                          :key="'t-' + port.id"
                          class="port-cell"
                          :class="[
                            !port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'),
                            selectedPortIds.includes(port.id) ? 'port-selected' : '',
                          ]"
                          @click="togglePortSelection(port, $event)"
                        >
                          {{ port.id }}
                          <span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                      <div class="port-row">
                        <div
                          v-for="port in group.bottomRow"
                          :key="'b-' + port.id"
                          class="port-cell"
                          :class="[
                            !port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'),
                            selectedPortIds.includes(port.id) ? 'port-selected' : '',
                          ]"
                          @click="togglePortSelection(port, $event)"
                        >
                          {{ port.id }}
                          <span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                    </div>
                  </template>

                  <!-- Vertical divider between standard and uplink -->
                  <div v-if="portLayout.uplinkGroups.length" class="chassis-divider"></div>

                  <!-- Uplink port groups -->
                  <template v-for="(group, ui) in portLayout.uplinkGroups" :key="'u-' + ui">
                    <div class="port-group">
                      <div class="port-row">
                        <div
                          v-for="port in group.topRow"
                          :key="'ut-' + port.id"
                          class="port-cell port-uplink"
                          :class="[
                            !port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'),
                            selectedPortIds.includes(port.id) ? 'port-selected' : '',
                          ]"
                          @click="togglePortSelection(port, $event)"
                        >
                          {{ port.id }}
                          <span class="port-tooltip">{{ getPortName(port) }}</span>
                        </div>
                      </div>
                      <div v-if="group.bottomRow.length" class="port-row">
                        <div
                          v-for="port in group.bottomRow"
                          :key="'ub-' + port.id"
                          class="port-cell port-uplink"
                          :class="[
                            !port.configured ? 'port-unconfigured' : (port.mode === 'access' ? 'port-access' : 'port-trunk'),
                            selectedPortIds.includes(port.id) ? 'port-selected' : '',
                          ]"
                          @click="togglePortSelection(port, $event)"
                        >
                          {{ port.id }}
                          <span class="port-tooltip">{{ getPortName(port) }}</span>
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

        <!-- Port Config Panel -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle>Port Config</CardTitle>
          </CardHeader>
          <CardContent>
            <div v-if="selectedPortsData.length > 0" class="space-y-4 animate-in slide-in-from-bottom-2 fade-in duration-200">
              <div class="bg-muted/50 border rounded-md p-3">
                <p class="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Editing {{ selectedPortIds.length }} Port(s)</p>
                <div class="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
                  <Badge variant="outline" v-for="port in selectedPortsData" :key="port.id" class="text-[10px] font-mono">
                    {{ port.id }}
                  </Badge>
                </div>
              </div>

              <!-- Only show bulk operations if none are configured, OR if some are configured we show edit forms -->
              <div v-if="selectedPortsData.some(p => !p.configured)">
                <Button class="w-full" @click="markConfigured">Enable Configuration</Button>
                <p class="text-xs text-muted-foreground mt-2 text-center">Click to configure selected ports</p>
              </div>

              <template v-if="selectedPortsData.every(p => p.configured)">
                <div class="space-y-1.5">
                  <Label>Description</Label>
                  <Input 
                    :model-value="selectedPortsData[0].description" 
                    @update:model-value="val => applyToSelected('description', val)"
                    placeholder="e.g. Uplink to Core" 
                  />
                  <p class="text-[10px] text-muted-foreground" v-if="selectedPortsData.length > 1">Applies to all selected</p>
                </div>

                <div class="space-y-1.5">
                  <Label>Mode</Label>
                  <div class="flex bg-muted rounded-md p-1 border">
                    <button
                      class="flex-1 text-xs py-1.5 rounded-sm font-medium transition-colors"
                      :class="selectedPortsData[0].mode === 'access' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'"
                      @click="applyToSelected('mode', 'access')"
                    >Access</button>
                    <button
                      class="flex-1 text-xs py-1.5 rounded-sm font-medium transition-colors"
                      :class="selectedPortsData[0].mode === 'trunk' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'"
                      @click="applyToSelected('mode', 'trunk')"
                    >Trunk</button>
                  </div>
                </div>

                <div v-if="selectedPortsData[0].mode === 'access'" class="space-y-1.5">
                  <Label>Access VLAN ID</Label>
                  <Input 
                    :model-value="selectedPortsData[0].vlan" 
                    @update:model-value="val => applyToSelected('vlan', val)"
                    type="number" min="1" max="4094" 
                  />
                </div>

                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Allowed Trunk VLANs</Label>
                  <Input 
                    :model-value="selectedPortsData[0].allowed_vlans" 
                    @update:model-value="val => applyToSelected('allowed_vlans', val)"
                    placeholder="all, or 10,20,30" 
                  />
                </div>

                <div v-if="selectedPortsData[0].mode === 'trunk'" class="space-y-1.5">
                  <Label>Native VLAN (Optional)</Label>
                  <Input 
                    :model-value="selectedPortsData[0].native_vlan" 
                    @update:model-value="val => applyToSelected('native_vlan', val)"
                    placeholder="e.g. 99" 
                    type="number" min="1" max="4094"
                  />
                </div>

                <div class="space-y-1.5 border-t pt-3 mt-3">
                  <Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-1">PoE Settings</Label>
                  <div class="space-y-2">
                    <div>
                      <Label class="text-xs">PoE Mode</Label>
                      <Select 
                        :model-value="selectedPortsData[0].poeMode"
                        @update:model-value="val => applyToSelected('poeMode', val)"
                      >
                        <SelectTrigger class="h-8 text-xs">
                          <SelectValue placeholder="Select PoE Mode" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default (Auto / Inherited)</SelectItem>
                          <SelectItem value="enabled">Explicitly Enabled (poe enable)</SelectItem>
                          <SelectItem value="disabled">Explicitly Disabled (no poe enable)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <!-- Extra fields when poeMode === 'enabled' -->
                    <div v-if="selectedPortsData[0].poeMode === 'enabled'" class="space-y-2 pl-3 border-l-2 border-primary/20 animate-in slide-in-from-left-2 duration-150">
                      <div>
                        <Label class="text-xs">PoE Priority</Label>
                        <Select 
                          :model-value="selectedPortsData[0].poePriority"
                          @update:model-value="val => applyToSelected('poePriority', val)"
                        >
                          <SelectTrigger class="h-8 text-xs">
                            <SelectValue placeholder="Select PoE Priority" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">Default</SelectItem>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="critical">Critical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label class="text-xs">Max Power (Watts)</Label>
                        <Input 
                          :model-value="selectedPortsData[0].poeMaxPower"
                          @update:model-value="val => applyToSelected('poeMaxPower', val)"
                          placeholder="e.g. 15.4 or 30 or 90"
                          type="number"
                          step="0.1"
                          min="0"
                          max="90"
                          class="h-8 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                </div>
                
                <div class="pt-2">
                  <Button variant="destructive" size="sm" class="w-full" @click="markUnconfigured">
                    Remove Configuration
                  </Button>
                </div>
              </template>
            </div>

            <div v-else class="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <svg class="w-8 h-8 mb-2 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
              </svg>
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
                <Button
                  :disabled="loading || !hostname.trim()"
                  @click="generateConfig"
                >{{ loading ? 'Generating…' : 'Generate Config' }}</Button>
              </div>
            </div>

            <TabsContent value="cli" class="p-4 m-0 border-none outline-none">
              <textarea
                v-model="configText"
                class="w-full bg-slate-950 text-emerald-400 font-mono text-sm p-4 rounded-md border resize-y min-h-[300px] focus:outline-none focus:ring-2 focus:ring-primary"
                readonly
                placeholder="Click 'Generate Config' to preview the CLI output..."
              ></textarea>
            </TabsContent>

            <TabsContent value="summary" class="p-4 m-0 border-none outline-none">
              <div class="bg-background border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interface</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>VLANs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="port in configuredPorts" :key="port.id">
                      <TableCell class="font-mono font-medium">{{ getPortName(port) }}</TableCell>
                      <TableCell>{{ port.description || '-' }}</TableCell>
                      <TableCell>
                        <Badge :variant="port.mode === 'access' ? 'default' : 'secondary'">{{ port.mode }}</Badge>
                      </TableCell>
                      <TableCell>
                        {{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}
                      </TableCell>
                    </TableRow>
                    <TableRow v-if="configuredPorts.length === 0">
                      <TableCell colspan="4" class="text-center py-10 text-muted-foreground">
                        No ports configured. Click a port in the chassis above to configure it.
                      </TableCell>
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
          <h2 class="text-3xl font-bold mb-4 border-b pb-2">Switch Provisioning Summary</h2>
          <div class="grid grid-cols-2 gap-6 text-sm">
            <div class="space-y-2">
              <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Identity</h3>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Hostname:</span> {{ hostname || 'Not set' }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Hardware Model:</span> {{ selectedModelId }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Admin Username:</span> {{ adminUsername || 'Not set' }}</div>
              <div v-if="adminPassword"><span class="font-semibold text-slate-500 w-32 inline-block">Admin Password:</span> <span class="text-xs bg-slate-100 border px-1 rounded">{{ adminPassword }}</span></div>
            </div>
            
            <div class="space-y-2">
              <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Services & Management</h3>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">SSH Service:</span> {{ enableSsh ? 'Enabled' : 'Disabled' }}</div>
              <div><span class="font-semibold text-slate-500 w-32 inline-block">Web Management:</span> {{ enableWeb ? 'Enabled' : 'Disabled' }}</div>
              <div v-if="mgmtIp"><span class="font-semibold text-slate-500 w-32 inline-block">Management IP:</span> {{ mgmtIp }} (VLAN {{ mgmtVlan }})</div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="text-xl font-bold mb-3 text-slate-800">VLAN Database</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="vlan in selectedVlans" :key="vlan.id" class="border border-slate-300 rounded px-2 py-1 text-sm bg-slate-50">
              <strong class="text-slate-600 mr-2">{{ vlan.id }}</strong> {{ vlan.name }}
            </span>
            <span v-if="selectedVlans.length === 0" class="italic text-slate-400">No VLANs defined.</span>
          </div>
        </div>

        <div>
          <h3 class="text-xl font-bold mb-3 text-slate-800 mt-6">Port Configurations ({{ configuredPorts.length }})</h3>
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
              <tr v-for="port in configuredPorts" :key="port.id">
                <td class="border border-slate-300 p-2 font-mono text-xs">{{ getPortName(port) }}</td>
                <td class="border border-slate-300 p-2">{{ port.description || '-' }}</td>
                <td class="border border-slate-300 p-2"><span class="uppercase text-[10px] tracking-wider font-bold text-slate-500">{{ port.mode }}</span></td>
                <td class="border border-slate-300 p-2">{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</td>
              </tr>
              <tr v-if="configuredPorts.length === 0">
                <td colspan="4" class="border border-slate-300 p-6 text-center italic text-slate-500">
                  No ports configured on this switch.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* Scoped styles for the switch chassis */
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
  width: 34px;
  height: 26px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  font-family: var(--font-mono);
  cursor: pointer;
  border: 1.5px solid transparent;
  transition: all 0.12s ease;
  position: relative;
  user-select: none;
  flex-shrink: 0;
}
.port-cell:hover { transform: scale(1.15); z-index: 10; }
.port-cell:active { transform: scale(0.92); }

/* Port states */
.port-unconfigured {
  background: hsl(var(--muted));
  border-color: hsl(var(--border));
  color: hsl(var(--muted-foreground));
}
.port-access {
  background: rgba(6, 182, 212, 0.15);
  border-color: rgba(6, 182, 212, 0.4);
  color: #06b6d4;
}
.port-trunk {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}
.port-selected {
  border-color: hsl(var(--primary)) !important;
  box-shadow: 0 0 0 2px rgba(var(--primary), 0.3), 0 0 10px -2px rgba(var(--primary), 0.4) !important;
  transform: scale(1.15);
  z-index: 10;
}
.port-uplink {
  border-style: dashed;
  width: 38px;
  height: 26px;
}
.port-group {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
}
.port-row {
  display: flex;
  gap: 2px;
}
.port-group + .port-group {
  margin-left: 8px;
}
.chassis-divider {
  width: 1px;
  align-self: stretch;
  background: hsl(var(--border));
  margin: 0 10px;
  flex-shrink: 0;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

/* Tooltip */
.port-tooltip {
  position: absolute;
  bottom: calc(100% + 5px);
  left: 50%;
  transform: translateX(-50%);
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  color: hsl(var(--popover-foreground));
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 9px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.1s;
  z-index: 50;
  font-family: var(--font-mono);
}
.port-cell:hover .port-tooltip { opacity: 1; }

/* VLAN Dropdown */
.vlan-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  min-width: 220px;
  max-height: 200px;
  overflow-y: auto;
  border-radius: var(--radius);
  border: 1px solid hsl(var(--border));
  background: hsl(var(--popover));
  box-shadow: 0 8px 30px -8px rgba(0, 0, 0, 0.5);
  padding: 4px;
}
.vlan-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: calc(var(--radius) - 2px);
  font-size: 13px;
  color: hsl(var(--popover-foreground));
  cursor: pointer;
}
.vlan-dropdown-item:hover {
  background: hsl(var(--accent));
  color: hsl(var(--accent-foreground));
}
.item-id {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: hsl(var(--primary));
  min-width: 28px;
}
</style>
