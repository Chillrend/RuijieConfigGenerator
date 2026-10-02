<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { io } from 'socket.io-client'
import { Icon } from '@iconify/vue'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import EditSwitchModal from '../components/EditSwitchModal.vue'

const router = useRouter()
const switches = ref([])
const hardwareModels = ref([])
const loading = ref(true)
const syncingAll = ref(false)
const syncingId = ref(null)
const searchQuery = ref('')
const errorMsg = ref('')

// Edit Switch Modal State
const editModalOpen = ref(false)
const switchBeingEdited = ref(null)

const openEditModal = (sw) => {
  switchBeingEdited.value = sw
  editModalOpen.value = true
}

const handleSwitchSaved = (updated) => {
  const idx = switches.value.findIndex(s => s.id === updated.id)
  if (idx !== -1) {
    switches.value[idx] = { ...switches.value[idx], ...updated }
  }
  fetchFleetSilent()
}

const handleSwitchDeleted = (deletedId) => {
  switches.value = switches.value.filter(s => s.id !== deletedId)
}

const deleteSwitchDirect = async (sw) => {
  const hostLabel = sw.hostname || sw.mgmt_ip || 'this switch'
  if (!confirm(`Are you sure you want to remove ${hostLabel} (${sw.mgmt_ip}) from fleet management?`)) {
    return
  }
  try {
    const res = await fetch(`/api/fleet/${sw.id}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to delete switch')
    handleSwitchDeleted(sw.id)
  } catch (err) {
    alert(err.message)
  }
}

// Sorting & Pagination State
const sortKey = ref('ip') // 'ip' | 'hostname' | 'status' | 'ports' | 'optical'
const sortOrder = ref('asc') // 'asc' | 'desc'
const currentPage = ref(1)
const pageSize = ref(15) // 15, 25, 50, 1000

// Numerical IPv4 Converter (Ensures e.g. 10.90.0.235 is correctly sorted before 10.90.2.1)
const ipToNumber = (ip) => {
  if (!ip || typeof ip !== 'string') return 0
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return 0
  return ((parseInt(parts[0], 10) || 0) * 16777216) +
         ((parseInt(parts[1], 10) || 0) * 65536) +
         ((parseInt(parts[2], 10) || 0) * 256) +
         ((parseInt(parts[3], 10) || 0))
}

const toggleSort = (key) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortOrder.value = 'asc'
  }
}

// Global Config Modal State
const globalModalOpen = ref(false)
const globalRunning = ref(false)
const globalStatus = ref('')
const globalResults = ref(null)
const grpcServerIp = ref('')
const grpcServerPort = ref(50051)

let socket = null

const setupSocket = () => {
  if (socket) socket.disconnect()
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] })

  socket.on('global-action:progress', (data) => {
    if (globalRunning.value && data.action === 'deploy-grpc') {
      const pct = Math.round((data.completed / data.total) * 100)
      globalStatus.value = `Deploying gRPC [${data.completed}/${data.total}] (${pct}%): ${data.current}...`
    }
  })

  // Real-time live fleet overview updates
  socket.on('fleet:switch-update', (update) => {
    const sw = switches.value.find(s => s.mgmt_ip === update.ip)
    if (sw) {
      sw.status = update.status
      sw.active_ports = update.active_ports
      if (update.total_ports && (!sw.total_ports || sw.total_ports === '—')) {
        sw.total_ports = update.total_ports
      }
      sw.uplink_count = update.uplink_count
      sw.optical_warnings = update.optical_warnings
      sw.last_seen = update.last_seen
      sw.telemetry_mode = update.telemetry_mode
      sw.is_live_grpc = true
    }
  })
}

const openGlobalModal = async () => {
  globalStatus.value = ''
  globalResults.value = null
  globalModalOpen.value = true
  try {
    const res = await fetch('/api/fleet/global-config/grpc-info', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      grpcServerIp.value = data.collectorIp || ''
      grpcServerPort.value = data.collectorPort || 50051
    }
  } catch (e) {}
}

const deployGrpcGlobal = async () => {
  const targetIp = grpcServerIp.value.trim()
  const targetPort = parseInt(grpcServerPort.value, 10) || 50051
  if (!targetIp) {
    alert('Please enter a valid Collector Server IP')
    return
  }
  const onlineCount = switches.value.filter(s => s.status === 'online').length
  if (onlineCount === 0) {
    alert('No online switches found in fleet. Offline switches are skipped.')
    return
  }
  if (!confirm(`Deploy gRPC Telemetry configuration to ${onlineCount} online switches pointing to ${targetIp}:${targetPort}? Offline devices will be skipped.`)) return
  globalRunning.value = true
  globalStatus.value = `Connecting to ${onlineCount} online switches via SSH and deploying clean gRPC preset (collector: ${targetIp}:${targetPort})...`
  globalResults.value = null

  // Timeout scales with fleet size: minimum 3 minutes, up to 10+ minutes for 50+ switches
  const timeoutMs = Math.max(180000, onlineCount * 25000)
  const timeoutSec = Math.round(timeoutMs / 1000)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch('/api/fleet/global-config/deploy-grpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        serverIp: targetIp,
        serverPort: targetPort
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to deploy gRPC configuration')
    globalResults.value = data
    globalStatus.value = `Completed: ${data.successful} switches configured successfully, ${data.failed} failed.`
    await fetchFleet()
  } catch (err) {
    globalStatus.value = `Error: ${err.name === 'AbortError' ? `Deployment timed out after ${timeoutSec}s` : err.message}`
  } finally {
    clearTimeout(timeoutId)
    globalRunning.value = false
  }
}

const syncConfigGlobal = async () => {
  globalRunning.value = true
  globalStatus.value = 'Queueing running-config sync for all switches...'
  globalResults.value = null
  try {
    const res = await fetch('/api/fleet/global-config/sync-config', {
      method: 'POST',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to trigger config sync')
    globalStatus.value = data.message || 'Config sync enqueued.'
    setTimeout(fetchFleet, 2000)
  } catch (err) {
    globalStatus.value = `Error: ${err.message}`
  } finally {
    globalRunning.value = false
  }
}

// Add Switch Modal State
const addModalOpen = ref(false)
const addSaving = ref(false)
const addError = ref('')
const addForm = ref({
  mgmt_ip: '',
  hostname: '',
  admin_username: 'admin',
  admin_password: '',
  enable_password: '',
  inventory_tag: '',
  model_id: ''
})

const openAddModal = async () => {
  addError.value = ''
  addForm.value = {
    mgmt_ip: '',
    hostname: '',
    admin_username: 'admin',
    admin_password: '',
    enable_password: '',
    inventory_tag: '',
    model_id: ''
  }
  addModalOpen.value = true
  if (hardwareModels.value.length === 0) {
    try {
      const res = await fetch('/api/setup', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        hardwareModels.value = data.hardware || []
      }
    } catch (e) {}
  }
}

const submitAddSwitch = async () => {
  if (!addForm.value.mgmt_ip) {
    addError.value = 'Management IP is required.'
    return
  }
  addSaving.value = true
  addError.value = ''
  try {
    const res = await fetch('/api/fleet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(addForm.value)
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to add switch')
    addModalOpen.value = false
    await fetchFleet()
    // Poll again after 3 seconds to update auto-discovered details
    setTimeout(fetchFleet, 3000)
  } catch (err) {
    addError.value = err.message
  } finally {
    addSaving.value = false
  }
}

const fetchFleet = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch('/api/fleet', { credentials: 'include' })
    if (!res.ok) throw new Error('Failed to load fleet data')
    const data = await res.json()
    switches.value = data.switches || []
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}

const syncSwitch = async (id, e) => {
  if (e) e.stopPropagation()
  syncingId.value = id
  try {
    const res = await fetch(`/api/fleet/${id}/sync`, {
      method: 'POST',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Sync failed')
    await fetchFleet()
  } catch (err) {
    alert(`Failed to sync switch: ${err.message}`)
  } finally {
    syncingId.value = null
  }
}

const syncAll = async () => {
  syncingAll.value = true
  try {
    const res = await fetch('/api/fleet/sync-all', {
      method: 'POST',
      credentials: 'include'
    })
    const data = await res.json()
    alert(data.message || 'Sync initiated for all switches')
    setTimeout(fetchFleet, 2000)
  } catch (err) {
    alert(`Failed to trigger fleet sync: ${err.message}`)
  } finally {
    syncingAll.value = false
  }
}

const importFromDeployments = async () => {
  loading.value = true
  try {
    const res = await fetch('/api/fleet/import-from-deployments', {
      method: 'POST',
      credentials: 'include'
    })
    await fetchFleet()
  } catch (err) {
    alert(err.message)
  } finally {
    loading.value = false
  }
}

const filteredSwitches = computed(() => {
  if (!searchQuery.value) return switches.value
  const q = searchQuery.value.toLowerCase()
  return switches.value.filter(s =>
    (s.hostname && s.hostname.toLowerCase().includes(q)) ||
    (s.mgmt_ip && s.mgmt_ip.includes(q)) ||
    (s.serial_number && s.serial_number.toLowerCase().includes(q)) ||
    (s.model_id && s.model_id.toLowerCase().includes(q)) ||
    (s.inventory_tag && s.inventory_tag.toLowerCase().includes(q))
  )
})

const sortedSwitches = computed(() => {
  const list = [...filteredSwitches.value]
  const order = sortOrder.value === 'asc' ? 1 : -1

  return list.sort((a, b) => {
    // Online devices always sort first regardless of the selected sort key
    const aOnline = a.status === 'online' ? 0 : 1
    const bOnline = b.status === 'online' ? 0 : 1
    if (aOnline !== bOnline) return aOnline - bOnline

    if (sortKey.value === 'ip') {
      return (ipToNumber(a.mgmt_ip) - ipToNumber(b.mgmt_ip)) * order
    }
    if (sortKey.value === 'hostname') {
      return (a.hostname || '').localeCompare(b.hostname || '') * order
    }
    if (sortKey.value === 'status') {
      return (a.status || '').localeCompare(b.status || '') * order
    }
    if (sortKey.value === 'ports') {
      return ((a.active_ports || 0) - (b.active_ports || 0)) * order
    }
    if (sortKey.value === 'optical') {
      return ((a.optical_warnings || 0) - (b.optical_warnings || 0)) * order
    }
    return 0
  })
})

const totalPages = computed(() => {
  if (pageSize.value >= 1000) return 1
  return Math.ceil(sortedSwitches.value.length / pageSize.value) || 1
})

const paginatedSwitches = computed(() => {
  if (pageSize.value >= 1000) return sortedSwitches.value
  const start = (currentPage.value - 1) * pageSize.value
  return sortedSwitches.value.slice(start, start + pageSize.value)
})

watch(searchQuery, () => {
  currentPage.value = 1
})

const stats = computed(() => {
  const total = switches.value.length
  const online = switches.value.filter(s => s.status === 'online').length
  const offline = switches.value.filter(s => s.status === 'offline').length
  const opticalIssues = switches.value.filter(s => s.optical_warnings > 0).length
  return { total, online, offline, opticalIssues }
})

let pollTimer = null

const fetchFleetSilent = async () => {
  try {
    const res = await fetch('/api/fleet', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      switches.value = data.switches || []
    }
  } catch (e) {}
}

onMounted(() => {
  fetchFleet()
  setupSocket()
  pollTimer = setInterval(fetchFleetSilent, 8000)
})

onUnmounted(() => {
  if (socket) socket.disconnect()
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-5 py-2">
    <!-- Top Bar with Stats -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
      <div>
        <h2 class="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Icon icon="carbon:network-4" class="w-6 h-6 text-primary" />
          Ruijie Switch Fleet
        </h2>
        <p class="text-sm text-muted-foreground mt-0.5">
          Real-time monitoring, optical health, uplink topology, and non-destructive configuration sync
        </p>
      </div>

      <div class="flex items-center gap-2.5">
        <Button variant="outline" size="sm" @click="router.push('/scanner')">
          <Icon icon="carbon:qr-code" class="w-4 h-4 mr-1.5 text-primary" />
          Scan Datamatrix
        </Button>
        <Button variant="secondary" size="sm" @click="openGlobalModal">
          <Icon icon="carbon:settings" class="w-4 h-4 mr-1.5" />
          Global Config
        </Button>
        <Button size="sm" @click="openAddModal">
          <Icon icon="lucide:plus" class="w-4 h-4 mr-1.5" />
          Add Switch
        </Button>
        <Button variant="outline" size="sm" @click="importFromDeployments" :disabled="loading">
          <Icon icon="lucide:refresh-cw" class="w-4 h-4 mr-1.5" />
          Sync from Deployments
        </Button>
        <Button variant="outline" size="sm" @click="syncAll" :disabled="syncingAll">
          <Icon icon="lucide:radio" class="w-4 h-4 mr-1.5" :class="syncingAll ? 'animate-pulse' : ''" />
          {{ syncingAll ? 'Polling Fleet...' : 'Poll All Devices' }}
        </Button>
      </div>
    </div>

    <!-- Quick Stat Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Managed</div>
          <div class="text-2xl font-bold mt-1">{{ stats.total }}</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Icon icon="carbon:network-enterprise" class="w-5 h-5" />
        </div>
      </div>

      <div class="p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Online Devices</div>
          <div class="text-2xl font-bold text-emerald-600 mt-1">{{ stats.online }}</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
          <Icon icon="carbon:checkmark-filled" class="w-5 h-5" />
        </div>
      </div>

      <div class="p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Offline Devices</div>
          <div class="text-2xl font-bold text-rose-600 mt-1">{{ stats.offline }}</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-rose-500/10 text-rose-600 flex items-center justify-center">
          <Icon icon="carbon:warning-alt-filled" class="w-5 h-5" />
        </div>
      </div>

      <div class="p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Optical Alerts</div>
          <div class="text-2xl font-bold mt-1" :class="stats.opticalIssues > 0 ? 'text-amber-500' : 'text-muted-foreground'">
            {{ stats.opticalIssues }}
          </div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center">
          <Icon icon="carbon:meter" class="w-5 h-5" />
        </div>
      </div>
    </div>

    <!-- Search / Filter -->
    <div class="flex items-center gap-3 mb-4">
      <div class="relative flex-1">
        <Icon icon="lucide:search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="searchQuery"
          placeholder="Search by Hostname, IP (10.90.x.x), Serial number, Tag, or Model..."
          class="pl-9 bg-card"
        />
      </div>
      <Button variant="outline" size="sm" @click="fetchFleet">
        <Icon icon="lucide:rotate-ccw" class="w-3.5 h-3.5 mr-1" />
        Refresh
      </Button>
    </div>

    <!-- Fleet Table -->
    <div class="border rounded-xl bg-card overflow-hidden shadow-xs">
      <div v-if="loading" class="py-16 text-center text-muted-foreground">
        <Icon icon="lucide:loader-2" class="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
        Loading switch fleet...
      </div>

      <div v-else-if="filteredSwitches.length === 0" class="py-16 text-center text-muted-foreground">
        <Icon icon="carbon:network-overlay" class="w-12 h-12 mx-auto mb-3 opacity-40" />
        <p class="text-base font-medium">No switches found matching criteria.</p>
        <p class="text-xs text-muted-foreground mt-1">Try clearing your search query or sync from deployments.</p>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider select-none">
              <!-- Sortable Status -->
              <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('status')">
                <div class="flex items-center gap-1">
                  <span>Status & Sync</span>
                  <Icon
                    v-if="sortKey === 'status'"
                    :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'"
                    class="w-3 h-3 text-primary"
                  />
                </div>
              </th>

              <!-- Sortable Hostname -->
              <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('hostname')">
                <div class="flex items-center gap-1">
                  <span>Switch Hostname</span>
                  <Icon
                    v-if="sortKey === 'hostname'"
                    :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'"
                    class="w-3 h-3 text-primary"
                  />
                </div>
              </th>

              <!-- Sortable IP -->
              <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('ip')">
                <div class="flex items-center gap-1">
                  <span>Management IP</span>
                  <Icon
                    v-if="sortKey === 'ip'"
                    :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'"
                    class="w-3 h-3 text-primary"
                  />
                </div>
              </th>

              <th class="py-2.5 px-3">Model & Firmware</th>

              <!-- Sortable Ports -->
              <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('ports')">
                <div class="flex items-center gap-1">
                  <span>Interfaces</span>
                  <Icon
                    v-if="sortKey === 'ports'"
                    :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'"
                    class="w-3 h-3 text-primary"
                  />
                </div>
              </th>

              <!-- Sortable Optical / Telemetry -->
              <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('optical')">
                <div class="flex items-center gap-1">
                  <span>Telemetry & Optics</span>
                  <Icon
                    v-if="sortKey === 'optical'"
                    :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'"
                    class="w-3 h-3 text-primary"
                  />
                </div>
              </th>

              <th class="py-2.5 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr
              v-for="sw in paginatedSwitches"
              :key="sw.id"
              class="hover:bg-muted/30 transition-colors cursor-pointer group"
              @click="router.push(`/fleet/${sw.id}`)"
            >
              <!-- Online/Offline Status & Last Seen (Combined) -->
              <td class="py-2 px-3">
                <div class="flex items-center gap-1.5">
                  <span
                    class="w-2 h-2 rounded-full shrink-0"
                    :class="{
                      'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]': sw.status === 'online',
                      'bg-rose-500': sw.status === 'offline',
                      'bg-amber-400': sw.status === 'error',
                      'bg-zinc-400': sw.status === 'unknown'
                    }"
                  />
                  <span class="text-xs font-semibold capitalize leading-none" :class="{
                    'text-emerald-600': sw.status === 'online',
                    'text-rose-600': sw.status === 'offline',
                    'text-muted-foreground': sw.status === 'unknown'
                  }">
                    {{ sw.status }}
                  </span>
                </div>
                <div class="text-[10px] text-muted-foreground mt-0.5 pl-3.5 whitespace-nowrap">
                  {{ sw.last_seen ? new Date(sw.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never' }}
                </div>
              </td>

              <!-- Hostname & Inventory Tag -->
              <td class="py-2 px-3">
                <div class="font-semibold text-xs text-foreground group-hover:text-primary transition-colors">
                  {{ sw.hostname || 'Unnamed Switch' }}
                </div>
                <div class="text-[10px] text-muted-foreground font-mono truncate max-w-[150px]">
                  {{ sw.inventory_tag || 'NO-TAG' }}<span v-if="sw.serial_number"> • {{ sw.serial_number }}</span>
                </div>
              </td>

              <!-- Management IP -->
              <td class="py-2 px-3 font-mono font-bold text-xs whitespace-nowrap text-foreground">
                {{ sw.mgmt_ip || '-' }}
              </td>

              <!-- Model & Firmware -->
              <td class="py-2 px-3">
                <div class="text-xs font-medium">{{ sw.model_id || 'Ruijie Switch' }}</div>
                <div class="text-[10px] text-muted-foreground truncate max-w-[130px]" :title="sw.software_version || ''">
                  {{ sw.software_version ? sw.software_version.replace(/RGOS\s*/i, '') : 'RGOS' }}
                </div>
              </td>

              <!-- Interfaces & Uplinks (Combined) -->
              <td class="py-2 px-3 whitespace-nowrap">
                <div class="flex items-center gap-1.5">
                  <span class="font-mono text-xs font-medium">
                    <span :class="sw.active_ports > 0 ? 'text-emerald-600 font-bold' : 'text-zinc-500'">{{ sw.active_ports }}</span>/{{ sw.total_ports || '—' }} Up
                  </span>
                  <span v-if="sw.uplink_count > 0" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-blue-600 bg-blue-500/10 px-1.5 py-0.2 rounded" title="Inter-switch uplinks detected">
                    <Icon icon="ph:arrow-fat-up-fill" class="w-2.5 h-2.5" />
                    {{ sw.uplink_count }}
                  </span>
                </div>
              </td>

              <!-- Diagnostics & Telemetry (Combined) -->
              <td class="py-2 px-3 whitespace-nowrap">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <!-- Telemetry Mode Badge -->
                  <span
                    v-if="sw.grpc_ip_mismatch"
                    class="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-600 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.2 rounded-full cursor-help"
                    :title="`gRPC IP Mismatch: configured for ${sw.grpc_configured_ip}, but server expects ${sw.grpc_expected_ip}`"
                  >
                    <Icon icon="carbon:warning-filled" class="w-2.5 h-2.5 text-amber-500" />
                    Wrong gRPC IP
                  </span>
                  <span
                    v-else-if="sw.telemetry_mode === 'grpc' || sw.is_live_grpc"
                    class="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.2 rounded-full"
                    title="Real-time telemetry streamed via gRPC dial-out to Redis"
                  >
                    <Icon icon="carbon:flash" class="w-2.5 h-2.5 text-emerald-600" />
                    gRPC
                  </span>
                  <span
                    v-else
                    class="inline-flex items-center gap-0.5 text-[10px] font-medium text-zinc-500 bg-zinc-500/10 border border-zinc-500/20 px-1.5 py-0.2 rounded-full"
                    title="Telemetry scraped periodically via SSH fallback"
                  >
                    <Icon icon="carbon:terminal" class="w-2.5 h-2.5" />
                    SSH
                  </span>

                  <!-- Optical indicator -->
                  <span v-if="sw.optical_warnings > 0" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-600 bg-amber-500/10 px-1.5 py-0.2 rounded">
                    <Icon icon="carbon:warning-filled" class="w-2.5 h-2.5" />
                    Optic Warn
                  </span>
                  <span v-else class="text-[10px] text-muted-foreground flex items-center gap-0.5" title="Optics Normal">
                    <Icon icon="carbon:checkmark" class="w-2.5 h-2.5 text-emerald-500" />
                    Optics OK
                  </span>
                </div>
              </td>

              <!-- Action Buttons -->
              <td class="py-2 px-3 text-right whitespace-nowrap" @click.stop>
                <div class="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Edit switch profile"
                    @click.stop="openEditModal(sw)"
                  >
                    <Icon icon="carbon:edit" class="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Poll switch via SSH"
                    :disabled="syncingId === sw.id"
                    @click="syncSwitch(sw.id, $event)"
                  >
                    <Icon
                      icon="lucide:refresh-cw"
                      class="w-3.5 h-3.5"
                      :class="syncingId === sw.id ? 'animate-spin text-primary' : ''"
                    />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-7 text-xs font-medium px-2.5"
                    @click="router.push(`/fleet/${sw.id}`)"
                  >
                    Manage
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="Delete switch from fleet"
                    @click.stop="deleteSwitchDirect(sw)"
                  >
                    <Icon icon="lucide:trash-2" class="w-3.5 h-3.5" />
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination Bar -->
        <div v-if="filteredSwitches.length > 0" class="p-3 border-t bg-muted/20 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground select-none">
          <div class="flex items-center gap-2">
            <span>Showing</span>
            <span class="font-semibold text-foreground">
              {{ (currentPage - 1) * (pageSize >= 1000 ? filteredSwitches.length : pageSize) + 1 }}–{{ Math.min(currentPage * pageSize, sortedSwitches.length) }}
            </span>
            <span>of</span>
            <span class="font-semibold text-foreground">{{ sortedSwitches.length }} switches</span>
            <span class="mx-1">•</span>
            <span>Page size:</span>
            <select
              v-model="pageSize"
              @change="currentPage = 1"
              class="border rounded px-2 py-0.5 text-xs bg-background text-foreground"
            >
              <option :value="15">15 per page</option>
              <option :value="25">25 per page</option>
              <option :value="50">50 per page</option>
              <option :value="1000">Show All</option>
            </select>
          </div>

          <div v-if="totalPages > 1" class="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              class="h-7 px-2.5 text-xs"
              :disabled="currentPage === 1"
              @click="currentPage--"
            >
              <Icon icon="lucide:chevron-left" class="w-3.5 h-3.5 mr-1" />
              Previous
            </Button>
            <span class="px-2 font-medium text-foreground">
              Page {{ currentPage }} of {{ totalPages }}
            </span>
            <Button
              variant="outline"
              size="sm"
              class="h-7 px-2.5 text-xs"
              :disabled="currentPage >= totalPages"
              @click="currentPage++"
            >
              Next
              <Icon icon="lucide:chevron-right" class="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Switch Modal -->
    <div
      v-if="addModalOpen"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-card text-card-foreground border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <!-- Modal Header -->
        <div class="p-5 border-b flex items-center justify-between bg-muted/30">
          <div>
            <h3 class="text-base font-bold flex items-center gap-2">
              <Icon icon="carbon:network-enterprise" class="w-5 h-5 text-primary" />
              Add Switch to Fleet
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Connect a provisioned Ruijie switch directly for real-time monitoring.
            </p>
          </div>
          <button @click="addModalOpen = false" class="text-muted-foreground hover:text-foreground">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-sm">
          <div v-if="addError" class="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg flex items-center gap-2">
            <Icon icon="lucide:alert-circle" class="w-4 h-4 shrink-0" />
            <span>{{ addError }}</span>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Management IP <span class="text-destructive">*</span></label>
              <Input
                v-model="addForm.mgmt_ip"
                placeholder="10.90.x.x"
                class="font-mono text-xs"
                required
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Hostname (Optional)</label>
              <Input
                v-model="addForm.hostname"
                placeholder="Auto-detected if blank"
                class="text-xs"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Admin Username</label>
              <Input
                v-model="addForm.admin_username"
                placeholder="admin"
                class="text-xs"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Admin Password</label>
              <Input
                v-model="addForm.admin_password"
                type="password"
                placeholder="••••••••"
                class="text-xs"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Enable / Super Password</label>
              <Input
                v-model="addForm.enable_password"
                type="password"
                placeholder="Same as Admin if blank"
                class="text-xs"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Inventory Tag</label>
              <Input
                v-model="addForm.inventory_tag"
                placeholder="e.g. SW-CORE-01"
                class="text-xs font-mono"
              />
            </div>
          </div>

          <div>
            <label class="text-xs font-semibold block mb-1">Switch Model</label>
            <select
              v-model="addForm.model_id"
              class="w-full border rounded-md px-3 py-2 text-xs bg-background"
            >
              <option value="">Auto-detect via SSH (Recommended)</option>
              <option v-for="hw in hardwareModels" :key="hw.id" :value="hw.id">
                {{ hw.id }} ({{ hw.totalPorts }} ports)
              </option>
            </select>
            <p class="text-[11px] text-muted-foreground mt-1">
              If left to Auto-detect, the switch model and ports are inspected automatically via SSH.
            </p>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="p-4 border-t flex items-center justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" @click="addModalOpen = false" :disabled="addSaving">
            Cancel
          </Button>
          <Button size="sm" @click="submitAddSwitch" :disabled="addSaving">
            <Icon icon="lucide:plus" class="w-4 h-4 mr-1.5" :class="addSaving ? 'animate-spin' : ''" />
            {{ addSaving ? 'Connecting...' : 'Add Switch' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- Global Fleet Configuration Modal -->
    <div
      v-if="globalModalOpen"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div class="bg-card text-card-foreground border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <!-- Modal Header -->
        <div class="p-5 border-b flex items-center justify-between bg-muted/30">
          <div>
            <h3 class="text-base font-bold flex items-center gap-2">
              <Icon icon="carbon:settings" class="w-5 h-5 text-primary" />
              Global Fleet Configuration
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Execute standardized configuration presets and fleet-wide management actions.
            </p>
          </div>
          <button @click="globalModalOpen = false" class="text-muted-foreground hover:text-foreground">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-sm">
          <div v-if="globalStatus" class="p-3 bg-primary/10 border border-primary/20 text-xs rounded-lg flex items-center gap-2 font-medium">
            <Icon icon="lucide:info" class="w-4 h-4 text-primary shrink-0" />
            <span>{{ globalStatus }}</span>
          </div>

          <!-- Action 1: Deploy gRPC -->
          <div class="p-4 rounded-xl border bg-muted/20 space-y-3">
            <div class="flex items-center justify-between">
              <div class="font-semibold text-sm flex items-center gap-2">
                <Icon icon="carbon:flash" class="w-4 h-4 text-emerald-500" />
                Enable gRPC Telemetry on Online Switches
              </div>
              <Button size="sm" class="bg-emerald-600 hover:bg-emerald-700 h-8 text-xs font-medium" :disabled="globalRunning" @click="deployGrpcGlobal">
                <Icon icon="lucide:play" class="w-3.5 h-3.5 mr-1" />
                Deploy Preset
              </Button>
            </div>
            <p class="text-xs text-muted-foreground leading-relaxed">
              Injects clean gRPC dial-out streaming to the configured collector server on all currently online switches (offline devices are automatically skipped). Replaces heavy SSH scraping with real-time streaming to Redis.
            </p>
            <div class="grid grid-cols-3 gap-2.5 pt-1 border-t border-border/50">
              <div class="col-span-2">
                <label class="text-[11px] font-semibold text-muted-foreground block mb-1">
                  Collector Server IP <span class="text-[10px] text-primary">(Detected from .env)</span>
                </label>
                <Input v-model="grpcServerIp" placeholder="10.23.9.10" class="h-8 text-xs font-mono" />
              </div>
              <div>
                <label class="text-[11px] font-semibold text-muted-foreground block mb-1">Port</label>
                <Input v-model="grpcServerPort" type="number" placeholder="50051" class="h-8 text-xs font-mono" />
              </div>
            </div>
          </div>

          <!-- Action 2: Daily Running Config Backup -->
          <div class="p-4 rounded-xl border bg-muted/20 space-y-2">
            <div class="flex items-center justify-between">
              <div class="font-semibold text-sm flex items-center gap-2">
                <Icon icon="carbon:document" class="w-4 h-4 text-blue-500" />
                Backup Running Configuration (All)
              </div>
              <Button size="sm" variant="outline" class="h-8 text-xs" :disabled="globalRunning" @click="syncConfigGlobal">
                <Icon icon="lucide:download-cloud" class="w-3.5 h-3.5 mr-1" />
                Sync Configs
              </Button>
            </div>
            <p class="text-xs text-muted-foreground leading-relaxed">
              Fetches <code>show running-config</code> from all switches and updates the local database state without running full interface metrics commands.
            </p>
          </div>

          <!-- Action 3: SSH Fallback Poll -->
          <div class="p-4 rounded-xl border bg-muted/20 space-y-2">
            <div class="flex items-center justify-between">
              <div class="font-semibold text-sm flex items-center gap-2">
                <Icon icon="carbon:terminal" class="w-4 h-4 text-amber-500" />
                Force SSH Full Polling
              </div>
              <Button size="sm" variant="outline" class="h-8 text-xs border-amber-500/30 text-amber-600 dark:text-amber-400" :disabled="globalRunning || syncingAll" @click="syncAll">
                <Icon icon="lucide:refresh-cw" class="w-3.5 h-3.5 mr-1" :class="syncingAll ? 'animate-spin' : ''" />
                Poll All
              </Button>
            </div>
            <p class="text-xs text-muted-foreground leading-relaxed">
              Performs an immediate, full legacy SSH scrape across all devices (commands: <code>show interfaces status</code>, <code>show transceiver</code>, etc.).
            </p>
          </div>

          <!-- Execution summary table if available -->
          <div v-if="globalResults && globalResults.results" class="pt-2">
            <h4 class="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Execution Results</h4>
            <div class="border rounded-lg overflow-hidden text-xs">
              <table class="w-full text-left">
                <thead class="bg-muted/40 font-semibold border-b">
                  <tr>
                    <th class="p-2">Switch</th>
                    <th class="p-2">IP</th>
                    <th class="p-2 text-right">Result</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr v-for="r in globalResults.results" :key="r.id">
                    <td class="p-2 font-medium">{{ r.hostname || 'Switch #' + r.id }}</td>
                    <td class="p-2 font-mono text-muted-foreground">{{ r.mgmt_ip }}</td>
                    <td class="p-2 text-right">
                      <span v-if="r.success" class="text-emerald-600 font-semibold">Success</span>
                      <span v-else class="text-rose-600" :title="r.error">Failed: {{ r.error }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="p-4 border-t flex items-center justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" @click="globalModalOpen = false" :disabled="globalRunning">
            Close
          </Button>
        </div>
      </div>
    </div>

    <!-- Edit Switch Profile Modal -->
    <EditSwitchModal
      v-model:open="editModalOpen"
      :switch-data="switchBeingEdited"
      :hardware-models="hardwareModels"
      @saved="handleSwitchSaved"
      @deleted="handleSwitchDeleted"
    />
  </div>
</template>
