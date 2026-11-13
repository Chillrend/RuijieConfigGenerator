<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { io } from 'socket.io-client'
import { Icon } from '@iconify/vue'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card'
import { ScrollArea, ScrollBar } from '../components/ui/scroll-area'
import EditSwitchModal from '../components/EditSwitchModal.vue'
import SshConsoleModal from '../components/SshConsoleModal.vue'

const route = useRoute()
const router = useRouter()
const switchId = route.params.id

const sw = ref(null)
const loading = ref(true)
const syncing = ref(false)
const activeTab = ref('ports') // 'ports' | 'optical' | 'lldp' | 'config'
const opticalHistory = ref([])
const errorMsg = ref('')
const deployingGrpc = ref(false)
const editModalOpen = ref(false)
const sshModalOpen = ref(false)

const handleSwitchSaved = (updatedData) => {
  if (!sw.value) return
  if (updatedData.mgmt_ip && updatedData.mgmt_ip !== sw.value.mgmt_ip && socket) {
    socket.emit('leave:switch', sw.value.mgmt_ip)
    socket.emit('join:switch', updatedData.mgmt_ip)
  }
  Object.assign(sw.value, updatedData)
  fetchSwitch()
}

const handleSwitchDeleted = () => {
  router.push('/fleet')
}

const deleteThisSwitch = async () => {
  if (!sw.value) return
  const hostLabel = sw.value.hostname || sw.value.mgmt_ip || 'this switch'
  if (!confirm(`Are you sure you want to remove ${hostLabel} (${sw.value.mgmt_ip}) from fleet management?`)) {
    return
  }
  try {
    const res = await fetch(`/api/fleet/${sw.value.id}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to delete switch')
    router.push('/fleet')
  } catch (err) {
    alert(err.message)
  }
}

let socket = null

const setupWebSocket = () => {
  if (!sw.value || !sw.value.mgmt_ip) return
  if (socket) socket.disconnect()

  socket = io(window.location.origin, {
    transports: ['websocket', 'polling']
  })

  socket.on('connect', () => {
    socket.emit('join:switch', sw.value.mgmt_ip)
  })

  socket.on('telemetry:update', (telemetry) => {
    if (!sw.value || telemetry.mgmt_ip !== sw.value.mgmt_ip) return
    sw.value.status = 'online'
    sw.value.telemetry_source = 'grpc'
    sw.value.last_seen = telemetry.last_seen

    // Live update interfaces & ports
    if (Array.isArray(telemetry.interfaces) && sw.value.ports) {
      const ifMap = new Map()
      telemetry.interfaces.forEach(i => {
        ifMap.set(i.name, i)
        ifMap.set(i.shortName, i)
      })

      const poeMap = new Map()
      ;(telemetry.poe || []).forEach(p => {
        poeMap.set(p.port, p)
        poeMap.set(p.portShort, p)
      })

      const optMap = new Map()
      ;(telemetry.optical || []).forEach(o => {
        optMap.set(o.port, o)
        optMap.set(o.portShort, o)
      })

      const lldpMap = new Map()
      ;(telemetry.lldp || []).forEach(l => {
        lldpMap.set(l.localPort, l)
        lldpMap.set(l.localPortShort, l)
      })

      for (const p of sw.value.ports) {
        const liveIf = ifMap.get(p.name) || ifMap.get(p.shortName)
        if (liveIf) {
          p.operStatus = liveIf.operStatus || p.operStatus
          if (liveIf.speed && liveIf.speed.toLowerCase() !== 'auto') {
            p.speed = liveIf.speed
          }
          if (liveIf.duplex && liveIf.duplex.toLowerCase() !== 'auto') {
            p.duplex = liveIf.duplex
          }
          if (liveIf.counters) p.counters = liveIf.counters
        }

        const livePoe = poeMap.get(p.name) || poeMap.get(p.shortName)
        if (livePoe) {
          p.poeStatus = livePoe.powerStatus || p.poeStatus
          p.poePower = livePoe.watt || 0
          p.poePowerStr = livePoe.currPower || `${livePoe.watt}W`
        }

        const liveOpt = optMap.get(p.name) || optMap.get(p.shortName)
        if (liveOpt) {
          p.optical = liveOpt
        }

        const livePeer = lldpMap.get(p.name) || lldpMap.get(p.shortName)
        if (livePeer) {
          p.uplinkNeighbor = livePeer.remoteDevice
          p.uplinkNeighborPort = livePeer.remotePort
          p.isUplink = livePeer.isUplink || p.isUplink
        }
      }

      if (Array.isArray(telemetry.optical) && telemetry.optical.length > 0) {
        sw.value.optical = telemetry.optical
      }
      if (Array.isArray(telemetry.lldp) && telemetry.lldp.length > 0) {
        sw.value.lldp = telemetry.lldp
      }
    }
  })
}

// Port configuration modal state
const selectedPort = ref(null)
const portModalOpen = ref(false)
const portSaving = ref(false)
const portEditForm = ref({
  portName: '',
  description: '',
  mode: 'access',
  vlan: '1',
  allowed_vlans: 'all',
  native_vlan: '',
  poeMode: 'default',
  poePriority: 'default',
  poeMaxPower: '',
  shutdown: false
})
const previewDeltaCommands = ref([])

const fetchSwitch = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`/api/fleet/${switchId}`, { credentials: 'include' })
    if (!res.ok) throw new Error('Failed to load switch details')
    const data = await res.json()
    sw.value = data.switch
    setupWebSocket()
    await fetchOpticalHistory()
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}

const formatAllowedVlans = (vlans) => {
  if (!vlans || vlans.toLowerCase() === 'all') return 'ALL'
  const trimmed = vlans.trim()
  if (trimmed.length > 12) {
    return trimmed.substring(0, 10) + '…'
  }
  return trimmed
}

// Hostname Edit State
const editingHostname = ref(false)
const hostnameInput = ref('')
const savingHostname = ref(false)

const startEditHostname = () => {
  hostnameInput.value = sw.value?.hostname || ''
  editingHostname.value = true
}

const cancelEditHostname = () => {
  editingHostname.value = false
}

const saveHostname = async () => {
  const newName = hostnameInput.value.trim()
  if (!newName) return
  savingHostname.value = true
  try {
    const res = await fetch(`/api/fleet/${sw.value.id}/hostname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ hostname: newName })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to update hostname')
    sw.value.hostname = newName
    editingHostname.value = false
    alert(`Hostname successfully changed to "${newName}" on switch via SSH.`)
  } catch (err) {
    alert(`Error updating hostname: ${err.message}`)
  } finally {
    savingHostname.value = false
  }
}

// gRPC Deploy Modal State
const grpcModalOpen = ref(false)
const grpcServerIp = ref('')
const grpcServerPort = ref(50051)

const openGrpcModal = async () => {
  grpcServerIp.value = sw.value?.grpc_expected_ip || ''
  grpcServerPort.value = sw.value?.grpc_expected_port || 50051
  if (!grpcServerIp.value) {
    try {
      const res = await fetch('/api/fleet/global-config/grpc-info', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        grpcServerIp.value = data.collectorIp || ''
        grpcServerPort.value = data.collectorPort || 50051
      }
    } catch (e) {}
  }
  grpcModalOpen.value = true
}

const confirmDeployGrpc = async () => {
  const targetIp = grpcServerIp.value.trim()
  const targetPort = parseInt(grpcServerPort.value, 10) || 50051
  if (!targetIp) {
    alert('Please enter a valid Collector Server IP')
    return
  }
  deployingGrpc.value = true
  grpcModalOpen.value = false
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 25000)
  try {
    const res = await fetch('/api/fleet/global-config/deploy-grpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        switchIds: [sw.value.id],
        serverIp: targetIp,
        serverPort: targetPort
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to deploy gRPC')
    alert(`gRPC telemetry deployed successfully pointing to ${targetIp}:${targetPort}! Switch will now stream directly to backend.`)
    await fetchSwitch()
  } catch (err) {
    alert(`Deploy failed: ${err.name === 'AbortError' ? 'Request timed out after 25s' : err.message}`)
  } finally {
    clearTimeout(timeoutId)
    deployingGrpc.value = false
  }
}

const deployGrpcToThisSwitch = () => {
  openGrpcModal()
}

const syncSwitch = async () => {
  syncing.value = true
  try {
    const res = await fetch(`/api/fleet/${switchId}/sync`, {
      method: 'POST',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Sync failed')
    await fetchSwitch()
  } catch (err) {
    alert(`Sync error: ${err.message}`)
  } finally {
    syncing.value = false
  }
}

const fetchOpticalHistory = async () => {
  try {
    const res = await fetch(`/api/fleet/${switchId}/optical-history`, { credentials: 'include' })
    const data = await res.json()
    opticalHistory.value = data.history || []
  } catch (e) {}
}

const getPortDescription = (optPort, optShort) => {
  if (!sw.value || !sw.value.ports) return '—'
  const p = sw.value.ports.find(x =>
    x.name === optPort ||
    x.shortName === optShort ||
    (optPort && x.name && x.name.toLowerCase() === optPort.toLowerCase()) ||
    (optShort && x.shortName && x.shortName.toLowerCase() === optShort.toLowerCase())
  )
  return p?.description || '—'
}

const getRxColor = (rx) => {
  if (rx === null || rx === undefined) return 'text-muted-foreground'
  if (rx < -20) return 'text-rose-600 font-bold'
  if (rx < -15) return 'text-amber-500 font-semibold'
  if (rx > 0) return 'text-amber-500 font-semibold'
  return 'text-emerald-600 font-semibold'
}

const getTxColor = (tx) => {
  if (tx === null || tx === undefined) return 'text-muted-foreground'
  if (tx < -15) return 'text-rose-600 font-bold'
  if (tx < -10) return 'text-amber-500 font-semibold'
  return 'text-foreground'
}

const opticalTransceivers = computed(() => {
  let list = []
  if (Array.isArray(sw.value?.optical) && sw.value.optical.length > 0) {
    list = [...sw.value.optical]
  } else if (Array.isArray(sw.value?.ports)) {
    list = sw.value.ports.filter(p => p.optical).map(p => p.optical)
  }

  // Filter out any non-physical ports like "Slot 0", "Chassis", "AggregatePort"
  const PORT_NAME_REGEX = /^(?:MTGigabitEthernet|MTGi|GigabitEthernet|Gi|TenGigabitEthernet|Te|TFGigabitEthernet|TF|TwentyFiveGigabitEthernet|25G|FortyGigabitEthernet|Fo|HundredGigabitEthernet|Hu|FastEthernet|Fa)\s*\d/i;
  list = list.filter(o => o.port && (PORT_NAME_REGEX.test(o.port) || PORT_NAME_REGEX.test(o.portShort)))

  // Restrict to ports that actually exist on this switch (removes phantom breakout channels 0/57..0/88 on modular switches)
  if (Array.isArray(sw.value?.ports) && sw.value.ports.length > 0) {
    const portNameSet = new Set()
    for (const p of sw.value.ports) {
      if (p.name) portNameSet.add(p.name.toLowerCase().trim())
      if (p.shortName) portNameSet.add(p.shortName.toLowerCase().trim())
    }
    list = list.filter(o => portNameSet.has((o.port || '').toLowerCase().trim()) || portNameSet.has((o.portShort || '').toLowerCase().trim()))
  }

  // Sort by port index number (e.g. 1..56 or 25..30)
  list.sort((a, b) => {
    const aMatch = (a.port || '').match(/\/(\d+)$/)
    const bMatch = (b.port || '').match(/\/(\d+)$/)
    if (aMatch && bMatch) {
      return parseInt(aMatch[1], 10) - parseInt(bMatch[1], 10)
    }
    return (a.port || '').localeCompare(b.port || '')
  })

  return list
})

// Compute standard 12-port groups and uplink block matching the real physical chassis layout
const portLayout = computed(() => {
  if (!sw.value || !sw.value.ports || sw.value.ports.length === 0) {
    return { groups: [], uplinkGroups: [] }
  }

  // Sort ports by numeric id
  const allPorts = [...sw.value.ports].sort((a, b) => (a.id || 0) - (b.id || 0))
  const uplinkSet = new Set(sw.value.hardware_template?.uplinkPorts || [])
  const stdPorts = allPorts.filter(p => uplinkSet.size > 0 ? !uplinkSet.has(p.id) : !p.isUplink)
  const upPorts = allPorts.filter(p => uplinkSet.size > 0 ? uplinkSet.has(p.id) : p.isUplink)

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

// Floating portal tooltip state
const hoveredPort = ref(null)
const tooltipStyle = ref({})

const handlePortMouseEnter = (port, event) => {
  hoveredPort.value = port
  const rect = event.currentTarget.getBoundingClientRect()
  const showBelow = rect.top < 140
  tooltipStyle.value = {
    position: 'fixed',
    left: `${rect.left + rect.width / 2}px`,
    top: showBelow ? `${rect.bottom + 8}px` : `${rect.top - 8}px`,
    transform: showBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    zIndex: 99999,
    pointerEvents: 'none'
  }
}

const handlePortMouseLeave = () => {
  hoveredPort.value = null
}

const openPortConfig = (port) => {
  selectedPort.value = port
  portEditForm.value = {
    portName: port.name,
    description: port.description || '',
    mode: port.mode || 'access',
    vlan: port.vlan || '1',
    allowed_vlans: port.allowed_vlans || 'all',
    native_vlan: port.native_vlan || '',
    poeMode: port.poeMode || 'default',
    poePriority: port.poePriority || 'default',
    poeMaxPower: port.poeMaxPower || '',
    shutdown: port.shutdown || false
  }
  generatePreviewDelta()
  portModalOpen.value = true
}

const generatePreviewDelta = () => {
  if (!selectedPort.value) return
  const cmds = []
  const p = selectedPort.value
  const f = portEditForm.value

  if (f.description !== (p.description || '')) {
    cmds.push(f.description ? `description ${f.description}` : 'no description')
  }
  if (f.mode !== (p.mode || 'access')) {
    cmds.push(`switchport mode ${f.mode}`)
  }
  if (f.mode === 'access' && f.vlan !== (p.vlan || '1')) {
    cmds.push(`switchport access vlan ${f.vlan}`)
  }
  if (f.mode === 'trunk') {
    if (f.allowed_vlans !== (p.allowed_vlans || 'all')) {
      cmds.push(`switchport trunk allowed vlan ${f.allowed_vlans}`)
    }
    if (f.native_vlan !== (p.native_vlan || '')) {
      cmds.push(f.native_vlan ? `switchport trunk native vlan ${f.native_vlan}` : 'no switchport trunk native vlan')
    }
  }
  if (f.poeMode !== (p.poeMode || 'default')) {
    cmds.push(f.poeMode === 'disabled' ? 'no poe enable' : 'poe enable')
  }
  if (f.shutdown !== (p.shutdown || false)) {
    cmds.push(f.shutdown ? 'shutdown' : 'no shutdown')
  }

  previewDeltaCommands.value = cmds
}

const savePortConfig = async () => {
  portSaving.value = true
  try {
    const res = await fetch(`/api/fleet/${switchId}/port-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(portEditForm.value)
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to update port')

    alert(`Targeted configuration applied successfully via SSH!\nDelta executed:\n${data.deltaCommands.join('\n')}`)
    portModalOpen.value = false
    await fetchSwitch()
  } catch (err) {
    alert(`Error applying config: ${err.message}`)
  } finally {
    portSaving.value = false
  }
}

// Mobile detection & Port Management States
const isMobile = ref(false)
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768
}

const portSearchQuery = ref('')
const portStatusFilter = ref('all') // 'all' | 'up' | 'down' | 'poe' | 'uplink'
const portViewMode = ref('auto') // 'auto' | 'cards' | 'table'
const legendOpen = ref(false)
const copiedIp = ref(false)
const copiedConfig = ref(false)

const effectivePortViewMode = computed(() => {
  if (portViewMode.value === 'cards') return 'cards'
  if (portViewMode.value === 'table') return 'table'
  return isMobile.value ? 'cards' : 'table'
})

const copySwitchIp = () => {
  if (!sw.value?.mgmt_ip) return
  navigator.clipboard.writeText(sw.value.mgmt_ip)
  copiedIp.value = true
  setTimeout(() => { copiedIp.value = false }, 2000)
}

const copyRunningConfig = () => {
  if (!sw.value?.raw_config) return
  navigator.clipboard.writeText(sw.value.raw_config)
  copiedConfig.value = true
  setTimeout(() => { copiedConfig.value = false }, 2000)
}

const downloadRunningConfig = () => {
  if (!sw.value?.raw_config) return
  const blob = new Blob([sw.value.raw_config], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sw.value.hostname || 'switch'}-${sw.value.mgmt_ip || 'config'}.cfg`
  a.click()
  URL.revokeObjectURL(url)
}

const portStats = computed(() => {
  const ports = sw.value?.ports || []
  return {
    total: ports.length,
    up: ports.filter(p => p.operStatus === 'up').length,
    down: ports.filter(p => p.operStatus !== 'up').length,
    poe: ports.filter(p => p.poeStatus === 'on' || p.poePower > 0).length,
    uplinks: ports.filter(p => p.isUplink).length
  }
})

const filteredPorts = computed(() => {
  let list = sw.value?.ports || []

  if (portStatusFilter.value === 'up') {
    list = list.filter(p => p.operStatus === 'up')
  } else if (portStatusFilter.value === 'down') {
    list = list.filter(p => p.operStatus !== 'up')
  } else if (portStatusFilter.value === 'poe') {
    list = list.filter(p => p.poeStatus === 'on' || p.poePower > 0)
  } else if (portStatusFilter.value === 'uplink') {
    list = list.filter(p => p.isUplink)
  }

  if (portSearchQuery.value) {
    const q = portSearchQuery.value.toLowerCase().trim()
    list = list.filter(p =>
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.shortName && p.shortName.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q)) ||
      (p.vlan && String(p.vlan).includes(q)) ||
      (p.allowed_vlans && p.allowed_vlans.toLowerCase().includes(q)) ||
      (p.uplinkNeighbor && p.uplinkNeighbor.toLowerCase().includes(q)) ||
      (p.mode && p.mode.toLowerCase().includes(q))
    )
  }

  return list
})

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  fetchSwitch()
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
  if (socket) {
    if (sw.value?.mgmt_ip) socket.emit('leave:switch', sw.value.mgmt_ip)
    socket.disconnect()
  }
})
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-5 py-2">
    <!-- Breadcrumb & Top Controls -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
      <div class="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
        <button @click="router.push('/fleet')" class="hover:text-foreground flex items-center gap-1 font-medium shrink-0">
          <Icon icon="lucide:arrow-left" class="w-4 h-4" />
          Fleet Overview
        </button>
        <span>/</span>
        <span class="text-foreground font-semibold truncate">{{ sw?.hostname || 'Switch Details' }}</span>
        <span
          v-if="sw?.group_name"
          class="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 shrink-0 ml-1"
        >
          {{ sw.group_name }}
        </span>
      </div>

      <div class="flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="outline" class="h-8 text-xs bg-primary/5 hover:bg-primary/10 border-primary/30 text-primary" @click="sshModalOpen = true">
          <Icon icon="carbon:terminal" class="w-3.5 h-3.5 mr-1" />
          SSH Console
        </Button>
        <Button size="sm" variant="outline" class="h-8 text-xs" @click="editModalOpen = true">
          <Icon icon="carbon:edit" class="w-3.5 h-3.5 mr-1" />
          Edit Profile
        </Button>
        <Button size="sm" variant="outline" class="h-8 text-xs" @click="fetchSwitch" :disabled="loading">
          <Icon icon="lucide:rotate-ccw" class="w-3.5 h-3.5 mr-1" />
          Reload
        </Button>
        <Button size="sm" class="h-8 text-xs" @click="syncSwitch" :disabled="syncing">
          <Icon icon="lucide:refresh-cw" class="w-3.5 h-3.5 mr-1.5" :class="syncing ? 'animate-spin' : ''" />
          {{ syncing ? 'Syncing...' : 'Sync Switch' }}
        </Button>
        <Button
          size="sm"
          variant="outline"
          class="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
          title="Delete switch from fleet"
          @click="deleteThisSwitch"
        >
          <Icon icon="lucide:trash-2" class="w-3.5 h-3.5 mr-1" />
          Delete
        </Button>
      </div>
    </div>

    <div v-if="loading" class="py-24 text-center text-muted-foreground">
      <Icon icon="lucide:loader-2" class="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
      Connecting to switch telemetry...
    </div>

    <div v-else-if="!sw" class="py-16 text-center text-muted-foreground">
      Switch not found or error loading data.
    </div>

    <div v-else class="space-y-6">
      <!-- Switch Header Card -->
      <div class="p-5 rounded-2xl border bg-card shadow-xs">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Icon icon="carbon:network-enterprise" class="w-7 h-7" />
            </div>
            <div>
              <div class="flex items-center gap-2.5 flex-wrap">
                <!-- Hostname with inline edit -->
                <div v-if="!editingHostname" class="flex items-center gap-1.5">
                  <h1 class="text-xl font-bold">{{ sw.hostname || 'Unnamed Switch' }}</h1>
                  <button
                    @click="startEditHostname"
                    class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                    title="Change switch hostname (applies via SSH to device)"
                  >
                    <Icon icon="lucide:pencil" class="w-3.5 h-3.5" />
                  </button>
                </div>
                <div v-else class="flex items-center gap-1.5">
                  <Input
                    v-model="hostnameInput"
                    class="h-7 text-xs font-semibold w-48 font-mono"
                    placeholder="New hostname"
                    :disabled="savingHostname"
                    @keyup.enter="saveHostname"
                    @keyup.esc="cancelEditHostname"
                  />
                  <Button size="sm" class="h-7 px-2 text-xs" :disabled="savingHostname" @click="saveHostname">
                    <Icon icon="lucide:check" class="w-3 h-3 mr-1" :class="savingHostname ? 'animate-spin' : ''" />
                    {{ savingHostname ? 'Pushing...' : 'Save' }}
                  </Button>
                  <Button size="sm" variant="ghost" class="h-7 px-1.5 text-xs" :disabled="savingHostname" @click="cancelEditHostname">
                    Cancel
                  </Button>
                </div>

                <Badge
                  :variant="sw.status === 'online' ? 'default' : 'destructive'"
                  class="capitalize text-xs font-semibold px-2.5"
                  :class="sw.status === 'online' ? 'bg-emerald-600 hover:bg-emerald-700' : ''"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-white mr-1.5 animate-pulse" v-if="sw.status === 'online'" />
                  {{ sw.status }}
                </Badge>

                <!-- Wrong gRPC IP warning badge -->
                <Badge
                  v-if="sw.grpc_ip_mismatch"
                  variant="outline"
                  class="text-xs bg-amber-500/10 text-amber-600 border-amber-500/30 font-mono flex items-center gap-1 cursor-pointer hover:bg-amber-500/20"
                  :title="`Configured for ${sw.grpc_configured_ip}, but server expects ${sw.grpc_expected_ip}. Click to reconfigure.`"
                  @click="openGrpcModal"
                >
                  <Icon icon="carbon:warning-filled" class="w-3.5 h-3.5 text-amber-500" />
                  Wrong gRPC IP ({{ sw.grpc_configured_ip }})
                </Badge>

                <Badge
                  v-else-if="sw.telemetry_source === 'grpc' || sw.is_live_grpc"
                  variant="outline"
                  class="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/20 font-mono flex items-center gap-1"
                >
                  <Icon icon="carbon:flash" class="w-3.5 h-3.5 text-emerald-600" />
                  gRPC Realtime
                </Badge>
                <Badge
                  v-else
                  variant="outline"
                  class="text-xs bg-zinc-500/10 text-zinc-500 border-zinc-500/20 font-mono flex items-center gap-1"
                >
                  <Icon icon="carbon:terminal" class="w-3.5 h-3.5" />
                  SSH Fallback
                </Badge>
                <Badge
                  v-if="sw.group_name"
                  variant="outline"
                  class="text-xs bg-primary/10 text-primary border-primary/20 font-medium flex items-center gap-1"
                >
                  <Icon icon="carbon:folder-shared" class="w-3 h-3 text-primary" />
                  {{ sw.group_name }}
                </Badge>
                <button
                  @click="editModalOpen = true"
                  class="text-xs px-2 py-0.5 rounded-md font-mono bg-muted text-muted-foreground border hover:text-foreground hover:border-primary/50 transition-colors inline-flex items-center gap-1 cursor-pointer"
                  title="Click to edit switch profile"
                >
                  <span>{{ sw.inventory_tag || 'INV-NONE' }}</span>
                  <Icon icon="carbon:edit" class="w-3 h-3 text-muted-foreground" />
                </button>
              </div>
              <div class="flex flex-wrap items-center gap-y-1.5 gap-x-4 mt-2.5 text-xs text-muted-foreground font-mono">
                <div class="flex items-center gap-1 bg-muted/60 px-2 py-0.5 rounded-md">
                  <span>IP: <strong class="text-foreground">{{ sw.mgmt_ip }}</strong></span>
                  <button
                    @click.stop="copySwitchIp"
                    class="p-0.5 hover:text-primary transition-colors text-muted-foreground rounded cursor-pointer"
                    title="Copy Management IP"
                  >
                    <Icon :icon="copiedIp ? 'lucide:check' : 'lucide:copy'" class="w-3 h-3" :class="copiedIp ? 'text-emerald-500' : ''" />
                  </button>
                </div>
                <div>Model: <span class="text-foreground font-semibold">{{ sw.model_id }}</span></div>
                <div class="hidden sm:inline">SN: <span class="text-foreground">{{ sw.serial_number || '-' }}</span></div>
                <div class="hidden md:inline">MAC: <span class="text-foreground">{{ sw.mac_address || '-' }}</span></div>
              </div>
            </div>
          </div>

          <!-- Firmware & Uptime Stats -->
          <div class="grid grid-cols-3 gap-3 border-t lg:border-t-0 lg:border-l pt-3 lg:pt-0 lg:pl-6 text-xs">
            <div>
              <div class="text-muted-foreground font-medium uppercase text-[10px] tracking-wider">Firmware</div>
              <div class="font-medium text-foreground mt-0.5 truncate max-w-[120px]">{{ sw.software_version ? sw.software_version.replace(/RGOS\s*/i, '') : 'RGOS' }}</div>
            </div>
            <div>
              <div class="text-muted-foreground font-medium uppercase text-[10px] tracking-wider">Uptime</div>
              <div class="font-medium text-foreground mt-0.5 truncate">{{ sw.uptime || '—' }}</div>
            </div>
            <div>
              <div class="text-muted-foreground font-medium uppercase text-[10px] tracking-wider">Last Sync</div>
              <div class="font-medium text-foreground mt-0.5 whitespace-nowrap">
                {{ sw.last_synced ? new Date(sw.last_synced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never' }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Real Switch Faceplate (Mirrors ProvisionerView) -->
      <Card class="overflow-hidden">
        <CardHeader class="pb-3 flex flex-col md:flex-row md:items-center justify-between gap-2 space-y-0">
          <div class="flex items-center justify-between w-full md:w-auto">
            <div>
              <CardTitle class="text-base flex items-center gap-2">
                <Icon icon="carbon:network-4" class="w-5 h-5 text-primary" />
                Switch Chassis Faceplate
              </CardTitle>
              <p class="text-xs text-muted-foreground mt-0.5">
                Physical layout for {{ sw.model_id }} • Click any port to configure
              </p>
            </div>
            <!-- Mobile Legend Toggle Button -->
            <button
              @click="legendOpen = !legendOpen"
              class="md:hidden text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1 rounded bg-muted/60"
            >
              <span>Legend</span>
              <Icon :icon="legendOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- Legend Items -->
          <div
            :class="legendOpen ? 'flex' : 'hidden md:flex'"
            class="items-center gap-2.5 text-xs text-muted-foreground flex-wrap pt-2 md:pt-0"
          >
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981]"></span>Link Up</span>
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-zinc-600"></span>Link Down</span>
            <span class="flex items-center gap-1"><span class="legend-dot bg-cyan-500/20 border-cyan-500/50 border"></span>Access</span>
            <span class="flex items-center gap-1"><span class="legend-dot bg-amber-500/20 border-amber-500/50 border"></span>Trunk</span>
            <span class="flex items-center gap-1 text-blue-500 font-semibold"><Icon icon="ph:arrow-fat-up-fill" class="w-3.5 h-3.5" />Uplink</span>
            <span class="flex items-center gap-1 text-amber-500 font-semibold"><Icon icon="ph:lightning-fill" class="w-3.5 h-3.5" />PoE</span>
            <span class="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold"><span class="px-1 text-[9px] bg-blue-500/20 border border-blue-400/30 rounded font-mono font-bold">Ag#</span>Lag</span>
          </div>
        </CardHeader>

        <CardContent>
          <ScrollArea class="w-full">
            <div class="switch-chassis min-w-max pb-2">
              <div class="flex items-center">
                <!-- Standard Port Groups (12-port chunks, 2 rows) -->
                <template v-for="(group, gi) in portLayout.groups" :key="'g-' + gi">
                  <div class="port-group">
                    <!-- Top Row (Odd ports: 1, 3, 5...) -->
                    <div class="port-row">
                      <div
                        v-for="port in group.topRow"
                        :key="'t-' + (port.id || port.name)"
                        class="port-cell relative"
                        :class="[
                          port.mode === 'access' ? 'port-access' : 'port-trunk',
                          port.operStatus === 'up' ? 'border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : '',
                          port.aggregatePort ? 'ring-1 ring-blue-500/40' : ''
                        ]"
                        @click="openPortConfig(port)"
                        @mouseenter="handlePortMouseEnter(port, $event)"
                        @mouseleave="handlePortMouseLeave"
                      >
                        <!-- LED indicator dot -->
                        <span
                          class="w-1.5 h-1.5 rounded-full absolute top-1 left-1"
                          :class="port.operStatus === 'up' ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-zinc-600'"
                        />
                        <!-- PoE Bolt Icon (Amber if device attached/active, crossed if explicitly disabled) -->
                        <Icon
                          v-if="port.poeStatus === 'on' || port.poePower > 0"
                          icon="ph:lightning-fill"
                          class="w-2.5 h-2.5 text-amber-400 absolute top-1 right-1"
                        />
                        <Icon
                          v-else-if="port.poeMode === 'disabled'"
                          icon="ph:lightning-slash-fill"
                          class="w-2.5 h-2.5 text-zinc-400 absolute top-1 right-1"
                        />
                        <!-- Connected Device (e.g. AP) Icon -->
                        <span
                          v-if="port.uplinkNeighbor && !port.isUplink"
                          class="absolute bottom-0.5 left-1 text-purple-400 leading-none"
                          :title="`Connected Device: ${port.uplinkNeighbor}`"
                        >
                          <Icon icon="carbon:wifi" class="w-2.5 h-2.5" />
                        </span>
                        <!-- Port ID Number -->
                        <span class="mt-1 font-mono font-bold">{{ port.id }}</span>
                        <!-- Aggregate Port Badge -->
                        <span
                          v-if="port.aggregatePort"
                          class="absolute bottom-0.5 right-0.5 text-[7px] font-mono leading-none bg-blue-500/25 text-blue-600 dark:text-blue-300 px-0.5 py-0.2 rounded font-bold border border-blue-400/30"
                        >
                          {{ port.aggregatePort }}
                        </span>
                      </div>
                    </div>

                    <!-- Bottom Row (Even ports: 2, 4, 6...) -->
                    <div class="port-row">
                      <div
                        v-for="port in group.bottomRow"
                        :key="'b-' + (port.id || port.name)"
                        class="port-cell relative"
                        :class="[
                          port.mode === 'access' ? 'port-access' : 'port-trunk',
                          port.operStatus === 'up' ? 'border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : '',
                          port.aggregatePort ? 'ring-1 ring-blue-500/40' : ''
                        ]"
                        @click="openPortConfig(port)"
                        @mouseenter="handlePortMouseEnter(port, $event)"
                        @mouseleave="handlePortMouseLeave"
                      >
                        <span
                          class="w-1.5 h-1.5 rounded-full absolute top-1 left-1"
                          :class="port.operStatus === 'up' ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-zinc-600'"
                        />
                        <Icon
                          v-if="port.poeStatus === 'on' || port.poePower > 0"
                          icon="ph:lightning-fill"
                          class="w-2.5 h-2.5 text-amber-400 absolute top-1 right-1"
                        />
                        <Icon
                          v-else-if="port.poeMode === 'disabled'"
                          icon="ph:lightning-slash-fill"
                          class="w-2.5 h-2.5 text-zinc-400 absolute top-1 right-1"
                        />
                        <!-- Connected Device (e.g. AP) Icon -->
                        <span
                          v-if="port.uplinkNeighbor && !port.isUplink"
                          class="absolute bottom-0.5 left-1 text-purple-400 leading-none"
                          :title="`Connected Device: ${port.uplinkNeighbor}`"
                        >
                          <Icon icon="carbon:wifi" class="w-2.5 h-2.5" />
                        </span>
                        <span class="mt-1 font-mono font-bold">{{ port.id }}</span>
                        <span
                          v-if="port.aggregatePort"
                          class="absolute bottom-0.5 right-0.5 text-[7px] font-mono leading-none bg-blue-500/25 text-blue-600 dark:text-blue-300 px-0.5 py-0.2 rounded font-bold border border-blue-400/30"
                        >
                          {{ port.aggregatePort }}
                        </span>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- Divider between standard ports and Uplink Cages -->
                <div v-if="portLayout.uplinkGroups.length" class="chassis-divider"></div>

                <!-- Uplink Port Groups (e.g. ports 25, 26, 27, 28) -->
                <template v-for="(group, ui) in portLayout.uplinkGroups" :key="'u-' + ui">
                  <div class="port-group">
                    <div class="port-row">
                      <div
                        v-for="port in group.topRow"
                        :key="'ut-' + (port.id || port.name)"
                        class="port-cell port-uplink relative"
                        :class="[
                          port.mode === 'access' ? 'port-access' : 'port-trunk',
                          port.operStatus === 'up' ? 'border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : '',
                          port.aggregatePort ? 'ring-1 ring-blue-500/40' : ''
                        ]"
                        @click="openPortConfig(port)"
                        @mouseenter="handlePortMouseEnter(port, $event)"
                        @mouseleave="handlePortMouseLeave"
                      >
                        <span
                          class="w-1.5 h-1.5 rounded-full absolute top-1 left-1"
                          :class="port.operStatus === 'up' ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-zinc-600'"
                        />
                        <Icon icon="ph:arrow-fat-up-fill" class="w-2.5 h-2.5 text-blue-400 absolute top-1 right-1" />
                        <span class="mt-1 font-mono font-bold">{{ port.id }}</span>
                        <span
                          v-if="port.aggregatePort"
                          class="absolute bottom-0.5 right-0.5 text-[7px] font-mono leading-none bg-blue-500/25 text-blue-600 dark:text-blue-300 px-0.5 py-0.2 rounded font-bold border border-blue-400/30"
                        >
                          {{ port.aggregatePort }}
                        </span>
                      </div>
                    </div>

                    <div v-if="group.bottomRow.length" class="port-row">
                      <div
                        v-for="port in group.bottomRow"
                        :key="'ub-' + (port.id || port.name)"
                        class="port-cell port-uplink relative"
                        :class="[
                          port.mode === 'access' ? 'port-access' : 'port-trunk',
                          port.operStatus === 'up' ? 'border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : '',
                          port.aggregatePort ? 'ring-1 ring-blue-500/40' : ''
                        ]"
                        @click="openPortConfig(port)"
                        @mouseenter="handlePortMouseEnter(port, $event)"
                        @mouseleave="handlePortMouseLeave"
                      >
                        <span
                          class="w-1.5 h-1.5 rounded-full absolute top-1 left-1"
                          :class="port.operStatus === 'up' ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-zinc-600'"
                        />
                        <Icon icon="ph:arrow-fat-up-fill" class="w-2.5 h-2.5 text-blue-400 absolute top-1 right-1" />
                        <span class="mt-1 font-mono font-bold">{{ port.id }}</span>
                        <span
                          v-if="port.aggregatePort"
                          class="absolute bottom-0.5 right-0.5 text-[7px] font-mono leading-none bg-blue-500/25 text-blue-600 dark:text-blue-300 px-0.5 py-0.2 rounded font-bold border border-blue-400/30"
                        >
                          {{ port.aggregatePort }}
                        </span>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </CardContent>
      </Card>

      <!-- Responsive Scrollable Tab Navigation -->
      <div class="border-b overflow-x-auto flex items-center gap-2 sm:gap-6 text-xs sm:text-sm font-medium whitespace-nowrap select-none">
        <button
          @click="activeTab = 'ports'"
          class="pb-3 border-b-2 transition-colors flex items-center gap-1.5 shrink-0"
          :class="activeTab === 'ports' ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <Icon icon="carbon:network-interface" class="w-4 h-4 shrink-0" />
          <span>Port Interfaces</span>
          <span class="text-xs px-1.5 py-0.2 rounded-full bg-muted font-mono font-medium">{{ sw.ports?.length || 0 }}</span>
        </button>

        <button
          @click="activeTab = 'optical'"
          class="pb-3 border-b-2 transition-colors flex items-center gap-1.5 shrink-0"
          :class="activeTab === 'optical' ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <Icon icon="carbon:meter" class="w-4 h-4 shrink-0" />
          <span>Optical DDM</span>
          <span class="text-xs px-1.5 py-0.2 rounded-full bg-muted font-mono font-medium">{{ opticalTransceivers.filter(o => o.status !== 'absent').length }}/{{ opticalTransceivers.length }}</span>
        </button>

        <button
          @click="activeTab = 'lldp'"
          class="pb-3 border-b-2 transition-colors flex items-center gap-1.5 shrink-0"
          :class="activeTab === 'lldp' ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <Icon icon="carbon:tree-view" class="w-4 h-4 shrink-0" />
          <span>LLDP Topology</span>
          <span class="text-xs px-1.5 py-0.2 rounded-full bg-muted font-mono font-medium">{{ sw.lldp?.length || 0 }}</span>
        </button>

        <button
          @click="activeTab = 'config'"
          class="pb-3 border-b-2 transition-colors flex items-center gap-1.5 shrink-0"
          :class="activeTab === 'config' ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <Icon icon="carbon:terminal" class="w-4 h-4 shrink-0" />
          <span>Running Config</span>
        </button>
      </div>

      <!-- TAB 1: Ports Management -->
      <div v-if="activeTab === 'ports'" class="space-y-3.5">
        <!-- Port Filter & Search Toolbar -->
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          <!-- Search box -->
          <div class="relative flex-1 min-w-[200px]">
            <Icon icon="lucide:search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              v-model="portSearchQuery"
              placeholder="Filter ports by name (Gi0/1), VLAN, PoE, or description..."
              class="pl-9 pr-8 bg-card text-xs h-9"
            />
            <button
              v-if="portSearchQuery"
              @click="portSearchQuery = ''"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <Icon icon="lucide:x" class="w-3.5 h-3.5" />
            </button>
          </div>

          <!-- Filter Chips & View Switcher -->
          <div class="flex items-center gap-1.5 flex-wrap">
            <button
              @click="portStatusFilter = 'all'"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
              :class="portStatusFilter === 'all' ? 'bg-primary/10 text-primary border border-primary/20 font-bold' : 'bg-muted/60 text-muted-foreground hover:text-foreground'"
            >
              All ({{ portStats.total }})
            </button>
            <button
              @click="portStatusFilter = 'up'"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
              :class="portStatusFilter === 'up' ? 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 font-bold' : 'bg-muted/60 text-muted-foreground hover:text-foreground'"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Up ({{ portStats.up }})
            </button>
            <button
              @click="portStatusFilter = 'down'"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
              :class="portStatusFilter === 'down' ? 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 border border-zinc-500/30 font-bold' : 'bg-muted/60 text-muted-foreground hover:text-foreground'"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-zinc-400" />
              Down ({{ portStats.down }})
            </button>
            <button
              @click="portStatusFilter = 'poe'"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
              :class="portStatusFilter === 'poe' ? 'bg-amber-500/15 text-amber-600 border border-amber-500/30 font-bold' : 'bg-muted/60 text-muted-foreground hover:text-foreground'"
            >
              <Icon icon="ph:lightning-fill" class="w-3 h-3 text-amber-500" />
              PoE ({{ portStats.poe }})
            </button>
            <button
              @click="portStatusFilter = 'uplink'"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
              :class="portStatusFilter === 'uplink' ? 'bg-blue-500/15 text-blue-600 border border-blue-500/30 font-bold' : 'bg-muted/60 text-muted-foreground hover:text-foreground'"
            >
              <Icon icon="ph:arrow-fat-up-fill" class="w-3 h-3 text-blue-500" />
              Uplinks ({{ portStats.uplinks }})
            </button>

            <!-- Mode Switcher -->
            <div class="flex items-center border rounded-md p-0.5 bg-muted/60 h-8 ml-auto sm:ml-0">
              <button
                @click="portViewMode = 'cards'"
                class="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition-all"
                :class="effectivePortViewMode === 'cards' ? 'bg-background shadow-xs text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'"
                title="Card View"
              >
                <Icon icon="carbon:grid" class="w-3.5 h-3.5" />
              </button>
              <button
                @click="portViewMode = 'table'"
                class="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition-all"
                :class="effectivePortViewMode === 'table' ? 'bg-background shadow-xs text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'"
                title="Table View"
              >
                <Icon icon="carbon:table" class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <!-- Empty state when search filters no ports -->
        <div v-if="filteredPorts.length === 0" class="py-12 text-center text-muted-foreground border rounded-xl bg-card">
          <Icon icon="carbon:network-overlay" class="w-10 h-10 mx-auto mb-2 opacity-40" />
          <p class="text-sm font-medium">No ports match filter criteria.</p>
          <button @click="portSearchQuery = ''; portStatusFilter = 'all'" class="text-xs text-primary underline mt-1">
            Reset filters
          </button>
        </div>

        <!-- PORT VIEW 1: RESPONSIVE CARDS (Mobile default) -->
        <div
          v-else-if="effectivePortViewMode === 'cards'"
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
        >
          <div
            v-for="p in filteredPorts"
            :key="p.name"
            class="bg-card border rounded-xl p-3.5 shadow-xs hover:border-primary/50 transition-all flex flex-col justify-between gap-2.5"
            :class="p.operStatus === 'up' ? 'border-l-4 border-l-emerald-500' : 'border-l-4 border-l-zinc-300 dark:border-l-zinc-700'"
          >
            <div>
              <!-- Card Header -->
              <div class="flex items-center justify-between gap-1.5 mb-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="font-mono font-bold text-sm text-foreground truncate">{{ p.shortName || p.name }}</span>
                  <span v-if="p.aggregatePort" class="text-[9px] font-bold px-1.5 py-0.2 rounded bg-blue-500/15 text-blue-600 font-mono border border-blue-400/20">
                    {{ p.aggregatePort }}
                  </span>
                  <span v-if="p.isUplink" class="text-blue-500" title="Uplink Port">
                    <Icon icon="ph:arrow-fat-up-fill" class="w-3.5 h-3.5" />
                  </span>
                </div>

                <span
                  class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                  :class="p.operStatus === 'up' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'"
                >
                  <span class="w-1.5 h-1.5 rounded-full" :class="p.operStatus === 'up' ? 'bg-emerald-500' : 'bg-zinc-400'" />
                  {{ (p.operStatus || 'DOWN').toUpperCase() }} {{ p.speed && p.operStatus === 'up' ? `(${p.speed})` : '' }}
                </span>
              </div>

              <!-- Card Body Info -->
              <div class="space-y-1.5 text-xs">
                <!-- VLAN & Mode -->
                <div class="flex items-center justify-between text-[11px]">
                  <span class="text-muted-foreground">VLAN / Mode</span>
                  <span v-if="p.mode === 'access'" class="px-1.5 py-0.2 rounded bg-muted font-mono font-semibold text-foreground">
                    VLAN {{ p.vlan || 1 }} (Access)
                  </span>
                  <span v-else class="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 font-mono font-semibold" :title="`Allowed: ${p.allowed_vlans}`">
                    Trunk: {{ formatAllowedVlans(p.allowed_vlans) }}
                  </span>
                </div>

                <!-- PoE Wattage -->
                <div class="flex items-center justify-between text-[11px]">
                  <span class="text-muted-foreground">PoE Power</span>
                  <span v-if="p.poeStatus === 'on' || p.poePower > 0" class="inline-flex items-center gap-1 text-amber-600 font-bold bg-amber-500/10 px-1.5 py-0.2 rounded">
                    <Icon icon="ph:lightning-fill" class="w-3 h-3" />
                    {{ p.poePowerStr || (p.poePower + 'W') }}
                  </span>
                  <span v-else-if="p.poeMode === 'disabled'" class="text-zinc-400 font-medium">Disabled</span>
                  <span v-else class="text-muted-foreground">0W</span>
                </div>

                <!-- Connected Device -->
                <div v-if="p.uplinkNeighbor" class="flex items-center justify-between text-[11px] pt-0.5">
                  <span class="text-muted-foreground">Connected</span>
                  <span
                    class="inline-flex items-center gap-1 font-semibold px-1.5 py-0.2 rounded text-[11px] truncate max-w-[150px]"
                    :class="p.isUplink ? 'text-blue-600 bg-blue-500/10' : 'text-purple-600 dark:text-purple-400 bg-purple-500/10'"
                  >
                    <Icon :icon="p.isUplink ? 'ph:arrow-fat-up-fill' : 'carbon:wifi'" class="w-3 h-3 shrink-0" />
                    <span class="truncate">{{ p.uplinkNeighbor }}</span>
                  </span>
                </div>

                <!-- Description -->
                <div v-if="p.description" class="text-[11px] text-muted-foreground italic truncate" :title="p.description">
                  "{{ p.description }}"
                </div>
              </div>
            </div>

            <!-- Card Action Footer -->
            <div class="pt-2 border-t flex items-center justify-end">
              <Button size="sm" variant="outline" class="w-full h-8 text-xs font-semibold" @click="openPortConfig(p)">
                <Icon icon="carbon:settings-adjust" class="w-3.5 h-3.5 mr-1 text-primary" />
                Configure Port
              </Button>
            </div>
          </div>
        </div>

        <!-- PORT VIEW 2: DESKTOP TABLE -->
        <div v-else class="border rounded-xl bg-card overflow-hidden shadow-xs">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <th class="py-2.5 px-3 min-w-[110px]">Port</th>
                  <th class="py-2.5 px-3">Status</th>
                  <th class="py-2.5 px-3">Speed</th>
                  <th class="py-2.5 px-3">Mode</th>
                  <th class="py-2.5 px-3">VLAN</th>
                  <th class="py-2.5 px-3">PoE</th>
                  <th class="py-2.5 px-3">Connected Peer</th>
                  <th class="py-2.5 px-3">Description</th>
                  <th class="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr
                  v-for="p in filteredPorts"
                  :key="p.name"
                  class="hover:bg-muted/30 transition-colors"
                >
                  <td class="py-2 px-3 font-mono font-semibold text-xs whitespace-nowrap">
                    <span :title="p.name">{{ p.shortName || p.name }}</span>
                    <span v-if="p.aggregatePort" class="ml-1 px-1.5 py-0.2 rounded text-[9px] font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400 font-mono border border-blue-400/20">
                      {{ p.aggregatePort }}
                    </span>
                  </td>
                  <td class="py-2 px-3">
                    <span
                      class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
                      :class="p.operStatus === 'up' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500'"
                    >
                      <span class="w-1.5 h-1.5 rounded-full" :class="p.operStatus === 'up' ? 'bg-emerald-500' : 'bg-zinc-400'" />
                      {{ (p.operStatus || 'DOWN').toUpperCase() }}
                    </span>
                  </td>
                  <td class="py-2 px-3 font-mono">{{ p.speed || 'Auto' }}</td>
                  <td class="py-2 px-3 capitalize font-medium">{{ p.mode || 'access' }}</td>
                  <td class="py-2 px-3 font-mono whitespace-nowrap">
                    <span v-if="p.mode === 'access'" class="px-1.5 py-0.5 rounded bg-muted text-foreground font-medium text-[11px]">
                      VLAN {{ p.vlan || 1 }}
                    </span>
                    <span
                      v-else
                      :title="`Allowed: ${p.allowed_vlans || 'ALL'}`"
                      class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 font-medium text-[11px] truncate max-w-[120px] inline-block"
                    >
                      {{ formatAllowedVlans(p.allowed_vlans) }}
                    </span>
                  </td>
                  <td class="py-2 px-3 whitespace-nowrap">
                    <span v-if="p.poeStatus === 'on' || p.poePower > 0" class="inline-flex items-center gap-1 text-amber-600 font-semibold bg-amber-500/10 px-1.5 py-0.5 rounded text-[11px]">
                      <Icon icon="ph:lightning-fill" class="w-3 h-3" />
                      {{ p.poePowerStr || (p.poePower + 'W') }}
                    </span>
                    <span v-else class="text-muted-foreground text-[11px]">0W</span>
                  </td>
                  <td class="py-2 px-3 text-xs max-w-[140px] truncate">
                    <div
                      v-if="p.uplinkNeighbor"
                      class="inline-flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap"
                      :class="p.isUplink ? 'text-blue-600 bg-blue-500/10' : 'text-purple-600 dark:text-purple-400 bg-purple-500/10'"
                    >
                      <Icon :icon="p.isUplink ? 'ph:arrow-fat-up-fill' : 'carbon:wifi'" class="w-3 h-3" />
                      <span class="truncate max-w-[110px]">{{ p.uplinkNeighbor }}</span>
                    </div>
                    <span v-else class="text-muted-foreground text-[11px]">—</span>
                  </td>
                  <td class="py-2 px-3 text-xs text-muted-foreground max-w-[140px] truncate">
                    {{ p.description || '—' }}
                  </td>
                  <td class="py-2 px-3 text-right whitespace-nowrap">
                    <Button variant="outline" size="sm" class="h-6 text-[11px] px-2.5 font-medium" @click="openPortConfig(p)">
                      Configure
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 2: Optical Status (DDM) -->
      <div v-if="activeTab === 'optical'" class="space-y-4">
        <div class="border rounded-xl bg-card overflow-hidden shadow-xs">
          <div class="p-4 border-b bg-muted/20 flex items-center justify-between">
            <h3 class="font-semibold text-sm flex items-center gap-2">
              <Icon icon="carbon:meter" class="w-4 h-4 text-primary" />
              SFP / SFP+ Optical Transceiver Diagnostics (DDM)
            </h3>
            <span class="text-xs text-muted-foreground font-mono">Telemetry pushed to InfluxDB</span>
          </div>

          <div v-if="!opticalTransceivers || opticalTransceivers.length === 0" class="py-12 text-center text-muted-foreground text-sm">
            No optical transceivers detected or switch has no active fiber ports inserted.
          </div>

          <div v-else>
            <!-- Mobile Optical Cards -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 md:hidden">
              <div
                v-for="opt in opticalTransceivers"
                :key="opt.port"
                class="bg-muted/30 border rounded-xl p-3 flex flex-col justify-between gap-2"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-bold text-sm text-foreground">{{ opt.portShort || opt.port }}</span>
                    <span v-if="opt.vendor" class="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-muted">
                      {{ opt.vendor }}
                    </span>
                  </div>
                  <span
                    class="px-2 py-0.5 rounded text-[10px] uppercase font-semibold"
                    :class="{
                      'bg-emerald-500/10 text-emerald-600': opt.status === 'normal',
                      'bg-amber-500/10 text-amber-600': opt.status === 'warning',
                      'bg-rose-500/10 text-rose-600': opt.status === 'critical',
                      'bg-slate-500/10 text-slate-500 border border-slate-500/20': opt.status === 'no_ddm',
                      'bg-zinc-500/10 text-zinc-400': opt.status === 'absent' || opt.status === 'no_signal'
                    }"
                  >
                    {{ opt.status === 'no_ddm' ? 'No DDM' : opt.status === 'no_signal' ? 'No Link' : opt.status === 'absent' ? 'Absent' : opt.status }}
                  </span>
                </div>

                <div class="text-xs text-muted-foreground truncate" :title="getPortDescription(opt.port, opt.portShort)">
                  {{ getPortDescription(opt.port, opt.portShort) }}
                </div>

                <div class="text-[11px] font-mono flex items-center justify-between pt-1 border-t">
                  <span class="text-muted-foreground">Power:</span>
                  <div v-if="opt.status === 'absent'" class="text-zinc-500">Absent</div>
                  <div v-else-if="opt.status === 'no_ddm'" class="text-zinc-500">No DDM</div>
                  <div v-else class="flex items-center gap-1">
                    <span class="text-[10px] text-muted-foreground">Rx</span>
                    <span :class="getRxColor(opt.rxPower)">{{ opt.rxPower !== null ? `${opt.rxPower}dBm` : '-' }}</span>
                    <span class="text-muted-foreground/60">/</span>
                    <span class="text-[10px] text-muted-foreground">Tx</span>
                    <span :class="getTxColor(opt.txPower)">{{ opt.txPower !== null ? `${opt.txPower}dBm` : '-' }}</span>
                  </div>
                </div>

                <div v-if="opt.temperature !== null" class="text-[11px] font-mono flex items-center justify-between text-muted-foreground">
                  <span>Temp & Volt:</span>
                  <span>{{ opt.temperature }}°C / {{ opt.voltage }}V</span>
                </div>
              </div>
            </div>

            <!-- Desktop Optical Table -->
            <div class="hidden md:block overflow-x-auto">
              <table class="w-full text-left border-collapse text-sm">
                <thead>
                  <tr class="border-b bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <th class="py-3 px-4">Port</th>
                    <th class="py-3 px-4">Port Description</th>
                    <th class="py-3 px-4">Brand</th>
                    <th class="py-3 px-4">Specs & Part Number</th>
                    <th class="py-3 px-4">Rx / Tx Power (dBm)</th>
                    <th class="py-3 px-4">Temp & Voltage</th>
                    <th class="py-3 px-4">Health</th>
                  </tr>
                </thead>
                <tbody class="divide-y font-mono text-xs">
                  <tr v-for="opt in opticalTransceivers" :key="opt.port" class="hover:bg-muted/30">
                    <td class="py-3 px-4 font-bold">{{ opt.portShort || opt.port }}</td>

                    <td class="py-3 px-4 font-sans text-xs text-muted-foreground truncate max-w-[200px]">
                      <span :title="getPortDescription(opt.port, opt.portShort)" class="font-medium text-foreground">
                        {{ getPortDescription(opt.port, opt.portShort) }}
                      </span>
                    </td>

                    <td class="py-3 px-4 font-sans">
                      <span v-if="opt.vendor" class="px-2 py-0.5 rounded bg-muted font-semibold text-xs text-foreground">
                        {{ opt.vendor }}
                      </span>
                      <span v-else-if="opt.status === 'absent'" class="text-zinc-500 italic">Absent</span>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>

                    <td class="py-3 px-4 font-sans text-xs">
                      <div v-if="opt.partNumber || opt.transceiverType" class="flex flex-col">
                        <span class="font-medium text-foreground">{{ opt.partNumber || opt.transceiverType }}</span>
                        <span class="text-[11px] text-muted-foreground font-mono" v-if="opt.transceiverType && opt.partNumber">
                          {{ opt.transceiverType }}{{ opt.wavelength ? ' (' + opt.wavelength + 'nm)' : '' }}
                        </span>
                      </div>
                      <span v-else-if="opt.status === 'absent'" class="text-zinc-500 italic">No module</span>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>

                    <td class="py-3 px-4">
                      <div v-if="opt.status === 'no_ddm'" class="text-xs text-muted-foreground italic font-sans flex items-center gap-1.5">
                        <Icon icon="carbon:warning-alt" class="w-3.5 h-3.5 text-slate-400" />
                        DDM not supported
                      </div>
                      <div v-else-if="opt.status === 'absent'" class="text-xs text-muted-foreground italic font-sans">
                        —
                      </div>
                      <div v-else class="flex items-center gap-1.5 font-mono text-xs whitespace-nowrap">
                        <span class="text-muted-foreground text-[10px]">Rx:</span>
                        <span :class="getRxColor(opt.rxPower)">
                          {{ opt.rxPower !== null ? `${opt.rxPower} dBm` : 'No Signal' }}
                        </span>
                        <span class="text-muted-foreground/60 font-sans">/</span>
                        <span class="text-muted-foreground text-[10px]">Tx:</span>
                        <span :class="getTxColor(opt.txPower)">
                          {{ opt.txPower !== null ? `${opt.txPower} dBm` : 'N/A' }}
                        </span>
                      </div>
                    </td>

                    <td class="py-3 px-4 text-xs font-mono whitespace-nowrap">
                      <span v-if="opt.temperature !== null || opt.voltage !== null">
                        {{ opt.temperature !== null ? `${opt.temperature}°C` : '—' }}
                        <span class="text-muted-foreground/60 mx-1">/</span>
                        {{ opt.voltage !== null ? `${opt.voltage}V` : '—' }}
                      </span>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>

                    <td class="py-3 px-4">
                      <span
                        class="px-2 py-0.5 rounded text-xs uppercase font-sans font-semibold whitespace-nowrap"
                        :class="{
                          'bg-emerald-500/10 text-emerald-600': opt.status === 'normal',
                          'bg-amber-500/10 text-amber-600': opt.status === 'warning',
                          'bg-rose-500/10 text-rose-600': opt.status === 'critical',
                          'bg-slate-500/10 text-slate-500 dark:text-slate-400 border border-slate-500/20': opt.status === 'no_ddm',
                          'bg-zinc-500/10 text-zinc-400': opt.status === 'absent' || opt.status === 'no_signal'
                        }"
                      >
                        {{ opt.status === 'no_ddm' ? 'No DDM' : opt.status === 'no_signal' ? 'No Link' : opt.status === 'absent' ? 'Absent' : opt.status }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 3: Uplink & LLDP Topology -->
      <div v-if="activeTab === 'lldp'" class="space-y-4">
        <div class="border rounded-xl bg-card overflow-hidden shadow-xs">
          <div class="p-4 border-b bg-muted/20">
            <h3 class="font-semibold text-sm flex items-center gap-2">
              <Icon icon="carbon:tree-view" class="w-4 h-4 text-primary" />
              Discovered LLDP Neighbors & Inter-Switch Uplinks
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Dynamically discovered neighboring switches, routers, and access points.
            </p>
          </div>

          <div v-if="!sw.lldp || sw.lldp.length === 0" class="py-12 text-center text-muted-foreground text-sm">
            No LLDP neighbors discovered. Ensure LLDP is enabled on connected devices.
          </div>

          <div v-else>
            <!-- Mobile LLDP Cards -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 md:hidden">
              <div
                v-for="item in sw.lldp"
                :key="item.localPort"
                class="bg-muted/30 border rounded-xl p-3 flex flex-col justify-between gap-2"
              >
                <div class="flex items-center justify-between">
                  <span class="font-mono font-bold text-sm text-foreground">{{ item.localPortShort || item.localPort }}</span>
                  <span
                    v-if="item.isUplink"
                    class="inline-flex items-center gap-1 text-[10px] font-bold text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-full"
                  >
                    <Icon icon="ph:arrow-fat-up-fill" class="w-3 h-3" />
                    Uplink
                  </span>
                  <span v-else class="text-[10px] text-muted-foreground font-medium bg-muted px-2 py-0.5 rounded-full">
                    Access Device
                  </span>
                </div>

                <div class="flex items-center gap-2">
                  <Icon :icon="item.isUplink ? 'carbon:network-enterprise' : 'carbon:wifi'" class="w-4 h-4 text-primary shrink-0" />
                  <span class="font-bold text-xs text-foreground truncate">{{ item.remoteDevice }}</span>
                </div>

                <div class="text-[11px] font-mono text-muted-foreground flex items-center justify-between pt-1 border-t">
                  <span>Remote Port:</span>
                  <span class="text-foreground font-semibold">{{ item.remotePort }}</span>
                </div>
                <div class="text-[11px] text-muted-foreground flex items-center justify-between">
                  <span>Capability:</span>
                  <span>{{ item.capability || 'Bridge' }}</span>
                </div>
              </div>
            </div>

            <!-- Desktop LLDP Table -->
            <div class="hidden md:block overflow-x-auto">
              <table class="w-full text-left border-collapse text-sm">
                <thead>
                  <tr class="border-b bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <th class="py-3 px-4">Local Port</th>
                    <th class="py-3 px-4">Remote System Name</th>
                    <th class="py-3 px-4">Remote Port</th>
                    <th class="py-3 px-4">Capabilities</th>
                    <th class="py-3 px-4">Classification</th>
                  </tr>
                </thead>
                <tbody class="divide-y text-xs">
                  <tr v-for="item in sw.lldp" :key="item.localPort" class="hover:bg-muted/30">
                    <td class="py-3 px-4 font-mono font-bold">{{ item.localPortShort || item.localPort }}</td>
                    <td class="py-3 px-4 font-semibold text-foreground flex items-center gap-1.5">
                      <Icon :icon="item.isUplink ? 'carbon:network-enterprise' : 'carbon:wifi'" class="w-4 h-4 text-muted-foreground" />
                      {{ item.remoteDevice }}
                    </td>
                    <td class="py-3 px-4 font-mono text-muted-foreground">{{ item.remotePort }}</td>
                    <td class="py-3 px-4">{{ item.capability || 'Bridge' }}</td>
                    <td class="py-3 px-4">
                      <span
                        v-if="item.isUplink"
                        class="inline-flex items-center gap-1 text-xs font-bold text-blue-600 bg-blue-500/10 px-2.5 py-0.5 rounded-full"
                      >
                        <Icon icon="ph:arrow-fat-up-fill" class="w-3.5 h-3.5" />
                        Inter-Switch Uplink
                      </span>
                      <span v-else class="text-muted-foreground font-medium">Access Device</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 4: Raw Running Config -->
      <div v-if="activeTab === 'config'" class="space-y-4">
        <!-- Telemetry Mode Notice -->
        <!-- Mismatch Warning Banner -->
        <div
          v-if="sw.grpc_ip_mismatch"
          class="p-4 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 flex items-start gap-3"
        >
          <Icon icon="carbon:warning-alt-filled" class="w-5 h-5 shrink-0 mt-0.5 text-rose-500" />
          <div class="flex-1 text-xs space-y-1">
            <div class="font-bold text-sm">gRPC Dial-Out Destination IP Mismatch Detected</div>
            <p>
              This switch is configured to dial out to <strong>{{ sw.grpc_configured_ip }}:{{ sw.grpc_configured_port || 50051 }}</strong>, but this server instance's collector IP in <code>.env</code> is <strong>{{ sw.grpc_expected_ip }}:{{ sw.grpc_expected_port || 50051 }}</strong>. Live telemetry is not reaching this backend.
            </p>
            <div class="pt-2">
              <Button
                size="sm"
                class="bg-rose-600 hover:bg-rose-700 text-white h-7 text-xs font-medium"
                :disabled="deployingGrpc"
                @click="openGrpcModal"
              >
                <Icon icon="carbon:flash" class="w-3.5 h-3.5 mr-1" />
                {{ deployingGrpc ? 'Deploying...' : `Update gRPC Destination to ${sw.grpc_expected_ip}` }}
              </Button>
            </div>
          </div>
        </div>

        <div
          v-else-if="!sw.grpc_configured"
          class="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-start gap-3"
        >
          <Icon icon="carbon:warning-alt" class="w-5 h-5 shrink-0 mt-0.5 text-amber-500" />
          <div class="flex-1 text-xs space-y-1">
            <div class="font-bold text-sm">SSH Fallback Scraping Active — No gRPC Configuration Detected</div>
            <p>
              The switch running configuration does not contain any gRPC dial-out directives. Telemetry is currently scraped via periodic SSH commands.
            </p>
            <div class="pt-2">
              <Button
                size="sm"
                variant="outline"
                class="h-7 text-xs border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                :disabled="deployingGrpc"
                @click="openGrpcModal"
              >
                <Icon icon="carbon:flash" class="w-3.5 h-3.5 mr-1" />
                {{ deployingGrpc ? 'Deploying gRPC...' : 'Enable gRPC Telemetry on this Switch' }}
              </Button>
            </div>
          </div>
        </div>

        <div
          v-else
          class="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-start gap-3"
        >
          <Icon icon="carbon:checkmark-filled" class="w-5 h-5 shrink-0 mt-0.5 text-emerald-500" />
          <div class="flex-1 text-xs space-y-1">
            <div class="font-bold text-sm">gRPC Dial-Out Telemetry Active</div>
            <p>
              gRPC dial-out streaming is enabled and pointing to <strong>{{ sw.grpc_configured_ip || sw.grpc_expected_ip }}:{{ sw.grpc_configured_port || 50051 }}</strong>. Port state, optical transceivers, and LLDP topology are pushed directly to Redis on port 50051.
            </p>
            <div class="pt-1">
              <Button
                size="sm"
                variant="outline"
                class="h-6 text-[11px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                :disabled="deployingGrpc"
                @click="openGrpcModal"
              >
                <Icon icon="carbon:settings" class="w-3 h-3 mr-1" />
                Reconfigure Collector IP / Port
              </Button>
            </div>
          </div>
        </div>

        <div class="border rounded-xl bg-card overflow-hidden shadow-xs">
          <div class="p-3.5 sm:p-4 border-b bg-muted/20 flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 class="font-semibold text-sm">Current Running Configuration</h3>
              <p class="text-xs text-muted-foreground">Read-only live copy from switch</p>
            </div>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="outline" class="h-8 text-xs" @click="copyRunningConfig" :disabled="!sw.raw_config">
                <Icon :icon="copiedConfig ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5 mr-1" :class="copiedConfig ? 'text-emerald-500' : ''" />
                {{ copiedConfig ? 'Copied!' : 'Copy Config' }}
              </Button>
              <Button size="sm" variant="outline" class="h-8 text-xs" @click="downloadRunningConfig" :disabled="!sw.raw_config">
                <Icon icon="lucide:download" class="w-3.5 h-3.5 mr-1" />
                Download .cfg
              </Button>
            </div>
          </div>
          <div class="p-4 bg-zinc-950 text-zinc-300 font-mono text-xs overflow-x-auto max-h-[600px] leading-relaxed">
            <pre>{{ sw.raw_config || 'No running config synced yet. Click "Sync Switch" to retrieve it via SSH.' }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Targeted Port Configuration Modal -->
    <div
      v-if="portModalOpen"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-card text-card-foreground border rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <!-- Modal Header -->
        <div class="p-5 border-b flex items-center justify-between bg-muted/30">
          <div>
            <h3 class="text-base font-bold flex items-center gap-2">
              <Icon icon="carbon:network-interface" class="w-5 h-5 text-primary" />
              Configure {{ selectedPort?.name }}
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Non-destructive update: Unsupported switch configurations are preserved.
            </p>
          </div>
          <button @click="portModalOpen = false" class="text-muted-foreground hover:text-foreground">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <!-- Aggregated Port Alert -->
          <div v-if="selectedPort?.aggregatePort" class="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <Icon icon="carbon:network-overlay" class="w-4 h-4 shrink-0" />
            <span>This port is an active member of <strong>{{ selectedPort.aggregatePort }}</strong>. Trunk and VLAN policies are bound to the AggregatePort.</span>
          </div>

          <!-- Port Description -->
          <div>
            <Label class="text-xs font-semibold">Port Description</Label>
            <Input
              v-model="portEditForm.description"
              placeholder="e.g. Workstation-VIP or AP-Hall-01"
              class="mt-1"
              @input="generatePreviewDelta"
            />
          </div>

          <!-- Port Mode -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <Label class="text-xs font-semibold">Switchport Mode</Label>
              <select
                v-model="portEditForm.mode"
                class="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-background"
                @change="generatePreviewDelta"
              >
                <option value="access">Access</option>
                <option value="trunk">Trunk</option>
              </select>
            </div>

            <!-- Access VLAN -->
            <div v-if="portEditForm.mode === 'access'">
              <Label class="text-xs font-semibold">Access VLAN</Label>
              <Input
                v-model="portEditForm.vlan"
                type="number"
                placeholder="1"
                class="mt-1 font-mono"
                @input="generatePreviewDelta"
              />
            </div>

            <!-- Trunk Allowed VLANs -->
            <div v-if="portEditForm.mode === 'trunk'">
              <Label class="text-xs font-semibold">Allowed VLANs</Label>
              <Input
                v-model="portEditForm.allowed_vlans"
                placeholder="e.g. 10,20,90 or all"
                class="mt-1 font-mono"
                @input="generatePreviewDelta"
              />
            </div>
          </div>

          <!-- Trunk Native VLAN -->
          <div v-if="portEditForm.mode === 'trunk'" class="grid grid-cols-2 gap-4">
            <div>
              <Label class="text-xs font-semibold">Native VLAN (Optional)</Label>
              <Input
                v-model="portEditForm.native_vlan"
                placeholder="e.g. 90"
                class="mt-1 font-mono"
                @input="generatePreviewDelta"
              />
            </div>
          </div>

          <!-- PoE Settings -->
          <div class="border-t pt-4">
            <h4 class="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Power over Ethernet (PoE)</h4>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <Label class="text-xs font-semibold">PoE Mode</Label>
                <select
                  v-model="portEditForm.poeMode"
                  class="w-full mt-1 border rounded-md px-2 py-1.5 text-xs bg-background"
                  @change="generatePreviewDelta"
                >
                  <option value="default">Default</option>
                  <option value="enabled">Enabled (PoE+)</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              <div>
                <Label class="text-xs font-semibold">Priority</Label>
                <select
                  v-model="portEditForm.poePriority"
                  class="w-full mt-1 border rounded-md px-2 py-1.5 text-xs bg-background"
                  @change="generatePreviewDelta"
                >
                  <option value="default">Default</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <div>
                <Label class="text-xs font-semibold">Max Power (W)</Label>
                <Input
                  v-model="portEditForm.poeMaxPower"
                  placeholder="e.g. 30000"
                  class="mt-1 text-xs"
                  @input="generatePreviewDelta"
                />
              </div>
            </div>
          </div>

          <!-- Unsupported Preserved Config Warning Box -->
          <div v-if="selectedPort?.unmanaged_lines?.length" class="p-3 bg-muted/60 border rounded-lg text-xs space-y-1">
            <div class="font-bold text-foreground flex items-center gap-1.5">
              <Icon icon="carbon:checkmark-outline" class="w-4 h-4 text-emerald-600" />
              Preserved Custom Configurations (Will NOT be deleted):
            </div>
            <ul class="list-disc pl-5 font-mono text-[11px] text-muted-foreground">
              <li v-for="line in selectedPort.unmanaged_lines" :key="line">{{ line }}</li>
            </ul>
          </div>

          <!-- CLI Delta Preview -->
          <div class="p-3 bg-zinc-950 text-zinc-300 rounded-lg text-xs font-mono space-y-1">
            <div class="text-[10px] text-zinc-500 uppercase font-sans font-bold">Generated SSH Delta Preview</div>
            <div v-if="previewDeltaCommands.length === 0" class="italic text-zinc-500">No modifications detected</div>
            <div v-else>
              <div>configure terminal</div>
              <div>interface {{ selectedPort?.name }}</div>
              <div v-for="cmd in previewDeltaCommands" :key="cmd" class="text-amber-400 pl-3">
                {{ cmd }}
              </div>
              <div>end</div>
              <div>write</div>
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="p-4 border-t flex items-center justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" @click="portModalOpen = false">
            Cancel
          </Button>
          <Button
            size="sm"
            @click="savePortConfig"
            :disabled="portSaving || previewDeltaCommands.length === 0"
          >
            <Icon icon="lucide:check" class="w-4 h-4 mr-1.5" />
            {{ portSaving ? 'Applying via SSH...' : 'Apply Delta to Switch' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- gRPC Deployment Modal -->
    <div
      v-if="grpcModalOpen"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-card text-card-foreground border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div class="p-5 border-b flex items-center justify-between bg-muted/30">
          <div>
            <h3 class="text-base font-bold flex items-center gap-2">
              <Icon icon="carbon:flash" class="w-5 h-5 text-emerald-500" />
              Configure gRPC Dial-Out
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Target collector server for streaming switch telemetry
            </p>
          </div>
          <button @click="grpcModalOpen = false" class="text-muted-foreground hover:text-foreground">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <div class="p-5 space-y-4 text-xs">
          <div v-if="sw.grpc_configured_ip" class="p-3 bg-muted/50 border rounded-lg space-y-1">
            <div class="font-semibold text-foreground">Current Switch Setting:</div>
            <div class="font-mono text-muted-foreground">
              Dial-out to: <strong>{{ sw.grpc_configured_ip }}:{{ sw.grpc_configured_port || 50051 }}</strong>
            </div>
            <div v-if="sw.grpc_ip_mismatch" class="text-rose-600 font-medium">
              ⚠ Mismatch with this server's IP ({{ sw.grpc_expected_ip }})
            </div>
          </div>

          <div class="space-y-3">
            <div>
              <label class="text-xs font-semibold block mb-1">
                Collector Server IP <span class="text-[10px] text-primary">(.env detected)</span>
              </label>
              <Input
                v-model="grpcServerIp"
                placeholder="10.23.9.10"
                class="font-mono text-xs"
                required
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Collector Server Port</label>
              <Input
                v-model="grpcServerPort"
                type="number"
                placeholder="50051"
                class="font-mono text-xs"
                required
              />
            </div>
          </div>

          <p class="text-muted-foreground leading-relaxed text-[11px]">
            This will connect to <strong>{{ sw.hostname || sw.mgmt_ip }}</strong> via SSH and configure the gRPC dial-out subscription to push real-time interface, optical, and LLDP metrics to this address.
          </p>
        </div>

        <div class="p-4 border-t flex items-center justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" @click="grpcModalOpen = false">
            Cancel
          </Button>
          <Button
            size="sm"
            class="bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
            @click="confirmDeployGrpc"
          >
            <Icon icon="carbon:flash" class="w-3.5 h-3.5 mr-1.5" />
            Deploy to Switch
          </Button>
        </div>
      </div>
    </div>

    <!-- Floating Tooltip Portal (Teleported to body to never clip) -->
    <Teleport to="body">
      <div v-if="hoveredPort" :style="tooltipStyle" class="pointer-events-none transition-opacity duration-75">
        <div class="bg-popover/95 backdrop-blur-md text-popover-foreground border border-border px-3 py-2.5 rounded-lg text-xs shadow-2xl font-mono min-w-[200px]">
          <div class="font-bold text-sm text-foreground flex items-center justify-between gap-2 border-b pb-1 mb-1">
            <span>{{ hoveredPort.name }}</span>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded font-sans font-semibold uppercase"
              :class="hoveredPort.operStatus === 'up' ? 'bg-emerald-500/20 text-emerald-600' : 'bg-zinc-500/20 text-zinc-400'"
            >
              {{ (hoveredPort.operStatus || 'DOWN').toUpperCase() }}
            </span>
          </div>

          <div class="text-[11px] text-muted-foreground">
            Speed: <span class="text-foreground font-semibold">{{ hoveredPort.speed || 'Auto' }}</span> • Duplex: <span class="text-foreground">{{ hoveredPort.duplex || 'Auto' }}</span>
          </div>

          <div class="text-[11px] mt-0.5">
            Mode: <span class="text-foreground font-semibold capitalize">{{ hoveredPort.mode || 'access' }}</span>
            <span v-if="hoveredPort.mode === 'access'" class="text-muted-foreground"> (VLAN {{ hoveredPort.vlan || 1 }})</span>
            <span v-else class="text-amber-500 font-semibold"> (Allowed: {{ hoveredPort.allowed_vlans || 'all' }})</span>
          </div>

          <div v-if="hoveredPort.uplinkNeighbor" class="text-[11px] text-blue-500 font-bold mt-0.5">
            Uplink: {{ hoveredPort.uplinkNeighbor }} <span v-if="hoveredPort.uplinkNeighborPort">({{ hoveredPort.uplinkNeighborPort }})</span>
          </div>

          <div v-if="hoveredPort.aggregatePort" class="text-[11px] text-blue-500 font-bold mt-0.5 flex items-center gap-1">
            <Icon icon="carbon:network-overlay" class="w-3.5 h-3.5" />
            Link Aggregation: {{ hoveredPort.aggregatePort }}
          </div>

          <div v-if="hoveredPort.poeStatus === 'on' || hoveredPort.poePower > 0" class="text-[11px] text-amber-500 font-semibold mt-0.5 flex items-center gap-1">
            <Icon icon="ph:lightning-fill" class="w-3.5 h-3.5" />
            PoE Active: {{ hoveredPort.poePowerStr || (hoveredPort.poePower + 'W') }} <span v-if="hoveredPort.poePdClass && hoveredPort.poePdClass !== 'N/A'" class="text-muted-foreground text-[10px] font-normal">(Class {{ hoveredPort.poePdClass }})</span>
          </div>
          <div v-else-if="hoveredPort.poeMode === 'disabled'" class="text-[11px] text-zinc-400 mt-0.5 flex items-center gap-1">
            <Icon icon="ph:lightning-slash-fill" class="w-3.5 h-3.5" />
            PoE: Disabled
          </div>

          <div v-if="hoveredPort.optical && hoveredPort.optical.status !== 'absent'" class="text-[11px] text-emerald-500 font-semibold mt-0.5">
            <span v-if="hoveredPort.optical.vendor" class="text-foreground font-bold">[{{ hoveredPort.optical.vendor }}] </span>
            Rx: {{ hoveredPort.optical.rxPower !== null ? hoveredPort.optical.rxPower + ' dBm' : 'N/A' }} • Tx: {{ hoveredPort.optical.txPower !== null ? hoveredPort.optical.txPower + ' dBm' : 'N/A' }}
            <span v-if="hoveredPort.optical.partNumber" class="text-[10px] text-muted-foreground block font-mono">Part: {{ hoveredPort.optical.partNumber }}</span>
          </div>

          <div v-if="hoveredPort.description" class="text-[10px] text-muted-foreground italic mt-1 border-t pt-1 max-w-[240px] truncate">
            {{ hoveredPort.description }}
          </div>

          <div class="text-[9px] text-primary/90 font-sans mt-1 pt-0.5 border-t border-border/50">
            Click to configure port
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Switch Profile Modal -->
    <EditSwitchModal
      v-model:open="editModalOpen"
      :switch-data="sw"
      @saved="handleSwitchSaved"
      @deleted="handleSwitchDeleted"
    />

    <!-- Interactive SSH Console Modal -->
    <SshConsoleModal
      v-model:open="sshModalOpen"
      :switch-data="sw"
    />
  </div>
</template>

<style scoped>
/* Switch Chassis Faceplate styling matching ProvisionerView */
.switch-chassis {
  background: linear-gradient(180deg, hsl(var(--muted)) 0%, hsl(var(--background)) 100%);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  padding: 38px 20px;
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
  width: 38px; height: 30px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; font-family: var(--font-mono);
  cursor: pointer; border: 1.5px solid hsl(var(--border));
  transition: all 0.12s ease; position: relative; user-select: none; flex-shrink: 0;
}
.port-cell:hover {
  transform: scale(1.15);
  z-index: 100 !important;
  border-color: hsl(var(--primary)) !important;
}
.port-cell:active { transform: scale(0.95); }
.port-access { background: rgba(6, 182, 212, 0.12); border-color: rgba(6, 182, 212, 0.4); color: #06b6d4; }
.port-trunk { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.4); color: #f59e0b; }
.port-uplink { border-style: dashed; width: 44px; height: 30px; }
.port-group {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}
.port-group:hover, .port-group:has(.port-cell:hover) {
  z-index: 50;
}
.port-row {
  display: flex;
  gap: 3px;
  position: relative;
}
.port-group + .port-group { margin-left: 8px; }
.chassis-divider { width: 1px; align-self: stretch; background: hsl(var(--border)); margin: 0 10px; flex-shrink: 0; }
.legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
</style>
