<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { io } from 'socket.io-client'
import { Icon } from '@iconify/vue'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import EditSwitchModal from '../components/EditSwitchModal.vue'
import SshConsoleModal from '../components/SshConsoleModal.vue'
import BatchSshModal from '../components/BatchSshModal.vue'

const router = useRouter()
const switches = ref([])
const hardwareModels = ref([])
const groups = ref([])
const loading = ref(true)
const syncingAll = ref(false)
const syncingId = ref(null)
const searchQuery = ref('')
const errorMsg = ref('')

// Responsive view detection
const isMobile = ref(false)
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768
}

// View & Filter States
const viewMode = ref('auto') // 'auto' | 'cards' | 'table'
const statusFilter = ref('all') // 'all' | 'online' | 'offline' | 'optical'
const selectedGroupFilter = ref('all') // 'all' | 'ungrouped' | groupName
const groupBy = ref('none') // 'none' | 'group' | 'prefix' | 'model'
const collapsedGroups = ref(new Set())
const actionsMenuOpen = ref(false)
const copiedIp = ref('')

const effectiveViewMode = computed(() => {
  if (viewMode.value === 'cards') return 'cards'
  if (viewMode.value === 'table') return 'table'
  return isMobile.value ? 'cards' : 'table'
})

const copyIp = (ip, e) => {
  if (e) e.stopPropagation()
  if (!ip) return
  navigator.clipboard.writeText(ip)
  copiedIp.value = ip
  setTimeout(() => {
    if (copiedIp.value === ip) copiedIp.value = ''
  }, 2000)
}

const toggleGroupCollapse = (key) => {
  const next = new Set(collapsedGroups.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  collapsedGroups.value = next
}

const setStatusFilter = (status) => {
  if (statusFilter.value === status) {
    statusFilter.value = 'all'
  } else {
    statusFilter.value = status
  }
  currentPage.value = 1
}

// Switch Group Management State
const manageGroupsModalOpen = ref(false)
const newGroupName = ref('')
const newGroupDesc = ref('')
const groupSaving = ref(false)
const groupError = ref('')

const openManageGroupsModal = () => {
  groupError.value = ''
  newGroupName.value = ''
  newGroupDesc.value = ''
  manageGroupsModalOpen.value = true
}

const fetchGroups = async () => {
  try {
    const res = await fetch('/api/fleet/groups', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      groups.value = data.groups || []
    }
  } catch (e) {}
}

const createGroup = async () => {
  const name = newGroupName.value.trim()
  if (!name) {
    groupError.value = 'Group name is required'
    return
  }
  groupSaving.value = true
  groupError.value = ''
  try {
    const res = await fetch('/api/fleet/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, description: newGroupDesc.value.trim() })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to create group')
    newGroupName.value = ''
    newGroupDesc.value = ''
    await fetchGroups()
  } catch (err) {
    groupError.value = err.message
  } finally {
    groupSaving.value = false
  }
}

const deleteGroup = async (g) => {
  if (!confirm(`Are you sure you want to delete group "${g.name}"? Switches in this group will become ungrouped.`)) {
    return
  }
  try {
    const res = await fetch(`/api/fleet/groups/${g.id}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to delete group')
    await fetchGroups()
    await fetchFleetSilent()
  } catch (err) {
    alert(err.message)
  }
}

// Edit Switch Modal State
const editModalOpen = ref(false)
const switchBeingEdited = ref(null)

// SSH Console Modal State
const sshModalOpen = ref(false)
const sshConsoleSwitch = ref(null)

const openSshConsole = (sw) => {
  sshConsoleSwitch.value = sw
  sshModalOpen.value = true
}

// Batch SSH Push Modal State
const batchModalOpen = ref(false)
const openBatchModal = () => {
  batchModalOpen.value = true
}

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
  fetchGroups()
}

const handleSwitchDeleted = (deletedId) => {
  switches.value = switches.value.filter(s => s.id !== deletedId)
  fetchGroups()
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

// Numerical IPv4 Converter
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
  group_name: '',
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
    group_name: '',
    model_id: ''
  }
  addModalOpen.value = true
  fetchGroups()
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
    await fetchGroups()
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

// Building / Prefix helper for smart grouping
const derivePrefix = (hostname, ip) => {
  if (hostname) {
    const match = hostname.match(/^(?:SW-)?(GD[A-Z0-9]+|GSG|HLT\d*|GPU\d*|Babon[A-Za-z0-9_-]*)/i)
    if (match) return match[1].toUpperCase()
  }
  if (ip) {
    const parts = ip.split('.')
    if (parts.length >= 3) return `Subnet ${parts[0]}.${parts[1]}.${parts[2]}.x`
  }
  return 'Other'
}

const filteredSwitches = computed(() => {
  let list = switches.value

  // Status Filter
  if (statusFilter.value === 'online') {
    list = list.filter(s => s.status === 'online')
  } else if (statusFilter.value === 'offline') {
    list = list.filter(s => s.status === 'offline')
  } else if (statusFilter.value === 'optical') {
    list = list.filter(s => s.optical_warnings > 0)
  }

  // Group Filter
  if (selectedGroupFilter.value === 'ungrouped') {
    list = list.filter(s => !s.group_name)
  } else if (selectedGroupFilter.value !== 'all') {
    list = list.filter(s => s.group_name === selectedGroupFilter.value)
  }

  // Search Query
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase().trim()
    list = list.filter(s =>
      (s.hostname && s.hostname.toLowerCase().includes(q)) ||
      (s.mgmt_ip && s.mgmt_ip.includes(q)) ||
      (s.serial_number && s.serial_number.toLowerCase().includes(q)) ||
      (s.model_id && s.model_id.toLowerCase().includes(q)) ||
      (s.inventory_tag && s.inventory_tag.toLowerCase().includes(q)) ||
      (s.group_name && s.group_name.toLowerCase().includes(q))
    )
  }

  return list
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

// Sections for grouped display (or single section if groupBy === 'none')
const switchSections = computed(() => {
  const list = sortedSwitches.value
  if (groupBy.value === 'none') {
    return [{ key: 'all', title: 'All Switches', switches: list }]
  }

  const map = new Map()

  for (const sw of list) {
    let groupKey = 'Ungrouped'
    let groupTitle = 'Ungrouped Switches'

    if (groupBy.value === 'group') {
      if (sw.group_name) {
        groupKey = sw.group_name
        groupTitle = sw.group_name
      } else {
        groupKey = '_ungrouped'
        groupTitle = 'Ungrouped'
      }
    } else if (groupBy.value === 'prefix') {
      groupKey = derivePrefix(sw.hostname, sw.mgmt_ip)
      groupTitle = groupKey
    } else if (groupBy.value === 'model') {
      groupKey = sw.model_id || 'Unknown Model'
      groupTitle = groupKey
    }

    if (!map.has(groupKey)) {
      map.set(groupKey, {
        key: groupKey,
        title: groupTitle,
        switches: [],
        onlineCount: 0,
        offlineCount: 0,
        warningCount: 0
      })
    }

    const sec = map.get(groupKey)
    sec.switches.push(sw)
    if (sw.status === 'online') sec.onlineCount++
    else if (sw.status === 'offline') sec.offlineCount++
    if (sw.optical_warnings > 0) sec.warningCount++
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.key === '_ungrouped') return 1
    if (b.key === '_ungrouped') return -1
    return a.title.localeCompare(b.title)
  })
})

const totalPages = computed(() => {
  if (pageSize.value >= 1000 || groupBy.value !== 'none') return 1
  return Math.ceil(sortedSwitches.value.length / pageSize.value) || 1
})

const paginatedSwitches = computed(() => {
  if (pageSize.value >= 1000 || groupBy.value !== 'none') return sortedSwitches.value
  const start = (currentPage.value - 1) * pageSize.value
  return sortedSwitches.value.slice(start, start + pageSize.value)
})

watch([searchQuery, statusFilter, selectedGroupFilter, groupBy], () => {
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

const closeActionsDropdown = (e) => {
  if (!e.target.closest('#fleet-actions-menu-wrapper')) {
    actionsMenuOpen.value = false
  }
}

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  document.addEventListener('click', closeActionsDropdown)
  fetchFleet()
  fetchGroups()
  setupSocket()
  pollTimer = setInterval(fetchFleetSilent, 8000)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
  document.removeEventListener('click', closeActionsDropdown)
  if (socket) socket.disconnect()
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="max-w-[1240px] mx-auto px-4 sm:px-5 py-2">
    <!-- Top Bar with Actions -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
      <div>
        <h2 class="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
          <Icon icon="carbon:network-4" class="w-5 h-5 sm:w-6 sm:h-6 text-primary shrink-0" />
          <span>Ruijie Switch Fleet</span>
        </h2>
        <p class="text-xs sm:text-sm text-muted-foreground mt-0.5">
          Real-time monitoring, optical health, uplink topology, and non-destructive configuration sync
        </p>
      </div>

      <!-- Action Toolbar -->
      <div class="flex items-center gap-2 flex-wrap">
        <!-- Direct Primary Action -->
        <Button size="sm" @click="openAddModal" class="h-8.5 shadow-xs font-semibold">
          <Icon icon="lucide:plus" class="w-4 h-4 mr-1.5" />
          Add Switch
        </Button>

        <!-- Desktop Quick Actions (hidden on small screens to save space) -->
        <div class="hidden lg:flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-8.5" @click="openManageGroupsModal">
            <Icon icon="carbon:folder-shared" class="w-4 h-4 mr-1.5 text-primary" />
            Manage Groups
          </Button>
          <Button variant="outline" size="sm" class="h-8.5" @click="router.push('/scanner')">
            <Icon icon="carbon:qr-code" class="w-4 h-4 mr-1.5 text-primary" />
            Scan QR
          </Button>
          <Button variant="outline" size="sm" class="h-8.5 border-primary/30 text-primary hover:bg-primary/10" @click="openBatchModal">
            <Icon icon="carbon:terminal" class="w-4 h-4 mr-1.5" />
            Batch SSH
          </Button>
          <Button variant="secondary" size="sm" class="h-8.5" @click="openGlobalModal">
            <Icon icon="carbon:settings" class="w-4 h-4 mr-1.5" />
            Global Config
          </Button>
          <Button variant="outline" size="sm" class="h-8.5" @click="syncAll" :disabled="syncingAll">
            <Icon icon="lucide:radio" class="w-4 h-4 mr-1.5" :class="syncingAll ? 'animate-pulse' : ''" />
            {{ syncingAll ? 'Polling...' : 'Poll All' }}
          </Button>
        </div>

        <!-- Mobile & Tablet Actions Dropdown Menu -->
        <div id="fleet-actions-menu-wrapper" class="relative lg:hidden">
          <Button
            variant="outline"
            size="sm"
            class="h-8.5"
            @click.stop="actionsMenuOpen = !actionsMenuOpen"
          >
            <Icon icon="carbon:overflow-menu-horizontal" class="w-4 h-4 mr-1.5" />
            <span>Tools</span>
            <Icon icon="lucide:chevron-down" class="w-3.5 h-3.5 ml-1 opacity-70" />
          </Button>

          <div
            v-if="actionsMenuOpen"
            class="absolute right-0 mt-1.5 w-56 rounded-xl border bg-card/98 backdrop-blur shadow-xl p-1.5 z-50 text-xs animate-in fade-in zoom-in-95 duration-100"
            @click="actionsMenuOpen = false"
          >
            <button
              @click="openManageGroupsModal"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="carbon:folder-shared" class="w-4 h-4 text-primary" />
              Manage Groups
            </button>
            <button
              @click="router.push('/scanner')"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="carbon:qr-code" class="w-4 h-4 text-primary" />
              Scan Datamatrix
            </button>
            <button
              @click="openBatchModal"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="carbon:terminal" class="w-4 h-4 text-primary" />
              Batch Push SSH
            </button>
            <button
              @click="openGlobalModal"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="carbon:settings" class="w-4 h-4 text-muted-foreground" />
              Global Config
            </button>
            <button
              @click="syncAll"
              :disabled="syncingAll"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="lucide:radio" class="w-4 h-4 text-emerald-500" />
              {{ syncingAll ? 'Polling Fleet...' : 'Poll All Devices' }}
            </button>
            <button
              @click="importFromDeployments"
              :disabled="loading"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted text-left font-medium transition-colors"
            >
              <Icon icon="lucide:refresh-cw" class="w-4 h-4 text-muted-foreground" />
              Sync from Deployments
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Stat Cards (Interactive Filter Chips) -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-5 select-none">
      <div
        role="button"
        tabindex="0"
        @click="setStatusFilter('all')"
        class="p-3.5 sm:p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between cursor-pointer transition-all hover:border-primary/50"
        :class="statusFilter === 'all' ? 'ring-2 ring-primary border-primary bg-primary/5' : ''"
      >
        <div>
          <div class="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Managed</div>
          <div class="text-xl sm:text-2xl font-bold mt-0.5 sm:mt-1">{{ stats.total }}</div>
        </div>
        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon icon="carbon:network-enterprise" class="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>

      <div
        role="button"
        tabindex="0"
        @click="setStatusFilter('online')"
        class="p-3.5 sm:p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between cursor-pointer transition-all hover:border-emerald-500/50"
        :class="statusFilter === 'online' ? 'ring-2 ring-emerald-500 border-emerald-500 bg-emerald-500/5' : ''"
      >
        <div>
          <div class="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Online Devices</div>
          <div class="text-xl sm:text-2xl font-bold text-emerald-600 mt-0.5 sm:mt-1">{{ stats.online }}</div>
        </div>
        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center shrink-0">
          <Icon icon="carbon:checkmark-filled" class="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>

      <div
        role="button"
        tabindex="0"
        @click="setStatusFilter('offline')"
        class="p-3.5 sm:p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between cursor-pointer transition-all hover:border-rose-500/50"
        :class="statusFilter === 'offline' ? 'ring-2 ring-rose-500 border-rose-500 bg-rose-500/5' : ''"
      >
        <div>
          <div class="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Offline Devices</div>
          <div class="text-xl sm:text-2xl font-bold text-rose-600 mt-0.5 sm:mt-1">{{ stats.offline }}</div>
        </div>
        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-rose-500/10 text-rose-600 flex items-center justify-center shrink-0">
          <Icon icon="carbon:warning-alt-filled" class="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>

      <div
        role="button"
        tabindex="0"
        @click="setStatusFilter('optical')"
        class="p-3.5 sm:p-4 rounded-xl border bg-card/60 backdrop-blur shadow-xs flex items-center justify-between cursor-pointer transition-all hover:border-amber-500/50"
        :class="statusFilter === 'optical' ? 'ring-2 ring-amber-500 border-amber-500 bg-amber-500/5' : ''"
      >
        <div>
          <div class="text-[10px] sm:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Optical Alerts</div>
          <div class="text-xl sm:text-2xl font-bold mt-0.5 sm:mt-1" :class="stats.opticalIssues > 0 ? 'text-amber-500' : 'text-muted-foreground'">
            {{ stats.opticalIssues }}
          </div>
        </div>
        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
          <Icon icon="carbon:meter" class="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>
    </div>

    <!-- Filter, Grouping & View Mode Controls -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 mb-3">
      <!-- Search Input -->
      <div class="relative flex-1 min-w-[200px]">
        <Icon icon="lucide:search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="searchQuery"
          placeholder="Search by Hostname, IP, Tag, Model, or Group..."
          class="pl-9 pr-8 bg-card text-xs h-9"
        />
        <button
          v-if="searchQuery"
          @click="searchQuery = ''"
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <Icon icon="lucide:x" class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Filters & Selectors -->
      <div class="flex items-center gap-2 flex-wrap">
        <!-- Group Filter Dropdown -->
        <select
          v-model="selectedGroupFilter"
          class="border rounded-md px-2.5 py-1.5 text-xs bg-card text-foreground h-9 font-medium"
        >
          <option value="all">All Groups</option>
          <option value="ungrouped">Ungrouped only</option>
          <option v-for="g in groups" :key="g.id" :value="g.name">
            Group: {{ g.name }} ({{ g.count }})
          </option>
        </select>

        <!-- Group By Mode Dropdown -->
        <select
          v-model="groupBy"
          class="border rounded-md px-2.5 py-1.5 text-xs bg-card text-foreground h-9 font-medium"
        >
          <option value="none">Flat List</option>
          <option value="group">Group by Switch Group</option>
          <option value="prefix">Group by Building Code</option>
          <option value="model">Group by Model</option>
        </select>

        <!-- View Mode Switcher -->
        <div class="flex items-center border rounded-md p-0.5 bg-muted/60 h-9">
          <button
            @click="viewMode = 'cards'"
            class="px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 transition-all"
            :class="effectiveViewMode === 'cards' ? 'bg-background shadow-xs text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'"
            title="Card Grid View"
          >
            <Icon icon="carbon:grid" class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">Cards</span>
          </button>
          <button
            @click="viewMode = 'table'"
            class="px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 transition-all"
            :class="effectiveViewMode === 'table' ? 'bg-background shadow-xs text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'"
            title="Table View"
          >
            <Icon icon="carbon:table" class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">Table</span>
          </button>
        </div>

        <Button variant="outline" size="sm" class="h-9 px-2.5 text-xs" @click="fetchFleet">
          <Icon icon="lucide:rotate-ccw" class="w-3.5 h-3.5 mr-1" />
          Refresh
        </Button>
      </div>
    </div>

    <!-- Active Filter Chips -->
    <div v-if="statusFilter !== 'all' || selectedGroupFilter !== 'all'" class="flex items-center gap-2 mb-3.5 text-xs flex-wrap">
      <span class="text-muted-foreground font-medium">Active filters:</span>
      <span
        v-if="statusFilter !== 'all'"
        class="inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 px-2.5 py-0.5 rounded-full font-medium"
      >
        Status: <strong class="capitalize">{{ statusFilter }}</strong>
        <button @click="statusFilter = 'all'" class="hover:opacity-75 ml-0.5">
          <Icon icon="lucide:x" class="w-3 h-3" />
        </button>
      </span>
      <span
        v-if="selectedGroupFilter !== 'all'"
        class="inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 px-2.5 py-0.5 rounded-full font-medium"
      >
        Group: <strong>{{ selectedGroupFilter }}</strong>
        <button @click="selectedGroupFilter = 'all'" class="hover:opacity-75 ml-0.5">
          <Icon icon="lucide:x" class="w-3 h-3" />
        </button>
      </span>
      <button
        @click="statusFilter = 'all'; selectedGroupFilter = 'all'"
        class="text-xs text-muted-foreground hover:text-foreground underline ml-1 cursor-pointer"
      >
        Clear filters
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-16 text-center text-muted-foreground border rounded-xl bg-card">
      <Icon icon="lucide:loader-2" class="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
      Loading switch fleet...
    </div>

    <!-- Empty State -->
    <div v-else-if="filteredSwitches.length === 0" class="py-16 text-center text-muted-foreground border rounded-xl bg-card">
      <Icon icon="carbon:network-overlay" class="w-12 h-12 mx-auto mb-3 opacity-40" />
      <p class="text-base font-semibold">No switches found matching criteria.</p>
      <p class="text-xs text-muted-foreground mt-1">Try clearing filters or search query.</p>
    </div>

    <!-- Content Sections (Grouped or Flat) -->
    <div v-else class="space-y-4">
      <div
        v-for="section in switchSections"
        :key="section.key"
        class="space-y-2.5"
      >
        <!-- Group Header (Shown when Group By is enabled) -->
        <div
          v-if="groupBy !== 'none'"
          @click="toggleGroupCollapse(section.key)"
          class="flex items-center justify-between p-3 rounded-xl border bg-card/80 backdrop-blur shadow-xs cursor-pointer hover:bg-muted/40 transition-colors select-none"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <Icon
              :icon="collapsedGroups.has(section.key) ? 'lucide:chevron-right' : 'lucide:chevron-down'"
              class="w-4 h-4 text-muted-foreground shrink-0 transition-transform"
            />
            <span class="font-bold text-sm text-foreground truncate">{{ section.title }}</span>
            <span class="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium shrink-0">
              {{ section.switches.length }} {{ section.switches.length === 1 ? 'switch' : 'switches' }}
            </span>
          </div>

          <!-- Section Mini Health Summary -->
          <div class="flex items-center gap-2 text-xs">
            <span class="inline-flex items-center gap-1 font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-md">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {{ section.onlineCount }} Up
            </span>
            <span v-if="section.offlineCount > 0" class="inline-flex items-center gap-1 font-semibold text-rose-600 bg-rose-500/10 px-2 py-0.5 rounded-md">
              <span class="w-1.5 h-1.5 rounded-full bg-rose-500" />
              {{ section.offlineCount }} Down
            </span>
            <span v-if="section.warningCount > 0" class="inline-flex items-center gap-1 font-semibold text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-md">
              <Icon icon="carbon:warning-filled" class="w-3 h-3 text-amber-500" />
              {{ section.warningCount }}
            </span>
          </div>
        </div>

        <!-- Section Content (Cards or Table) -->
        <div v-show="!collapsedGroups.has(section.key)">
          <!-- VIEW 1: RESPONSIVE CARDS VIEW -->
          <div
            v-if="effectiveViewMode === 'cards'"
            class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5"
          >
            <div
              v-for="sw in (groupBy !== 'none' ? section.switches : paginatedSwitches)"
              :key="sw.id"
              class="bg-card border rounded-xl p-4 shadow-xs hover:border-primary/50 transition-all cursor-pointer flex flex-col justify-between gap-3 group"
              @click="router.push(`/fleet/${sw.id}`)"
            >
              <!-- Card Top: Hostname, Status & Group -->
              <div>
                <div class="flex items-start justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="w-2.5 h-2.5 rounded-full shrink-0"
                      :class="{
                        'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]': sw.status === 'online',
                        'bg-rose-500': sw.status === 'offline',
                        'bg-amber-400': sw.status === 'error',
                        'bg-zinc-400': sw.status === 'unknown'
                      }"
                    />
                    <h3 class="font-bold text-sm text-foreground truncate group-hover:text-primary transition-colors">
                      {{ sw.hostname || 'Unnamed Switch' }}
                    </h3>
                  </div>

                  <span
                    v-if="sw.group_name"
                    class="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 shrink-0"
                  >
                    {{ sw.group_name }}
                  </span>
                </div>

                <!-- IP & Model row with click-to-copy -->
                <div class="flex items-center justify-between text-xs text-muted-foreground mb-2">
                  <div class="flex items-center gap-1 font-mono font-medium text-foreground">
                    <span>{{ sw.mgmt_ip || '-' }}</span>
                    <button
                      @click.stop="copyIp(sw.mgmt_ip, $event)"
                      class="p-1 hover:text-primary transition-colors text-muted-foreground rounded"
                      title="Copy IP"
                    >
                      <Icon
                        :icon="copiedIp === sw.mgmt_ip ? 'lucide:check' : 'lucide:copy'"
                        class="w-3.5 h-3.5"
                        :class="copiedIp === sw.mgmt_ip ? 'text-emerald-500' : ''"
                      />
                    </button>
                  </div>
                  <span class="text-[11px] truncate max-w-[120px]" :title="sw.model_id">
                    {{ sw.model_id ? sw.model_id.replace(/^RG-/, '') : 'Ruijie' }}
                  </span>
                </div>

                <!-- Visual Port Progress Bar -->
                <div class="bg-muted/40 rounded-lg p-2.5 mb-2.5 border border-border/40">
                  <div class="flex items-center justify-between text-[11px] mb-1">
                    <span class="text-muted-foreground">Interfaces Up</span>
                    <span class="font-mono font-semibold" :class="sw.active_ports > 0 ? 'text-emerald-600' : 'text-muted-foreground'">
                      {{ sw.active_ports || 0 }} / {{ sw.total_ports || '—' }} Up
                    </span>
                  </div>
                  <div class="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                    <div
                      class="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                      :style="{ width: `${Math.min(100, Math.round(((sw.active_ports || 0) / (parseInt(sw.total_ports, 10) || 24)) * 100))}%` }"
                    />
                  </div>
                </div>

                <!-- Health Badges (Uplinks, Optics, Telemetry) -->
                <div class="flex items-center gap-1.5 flex-wrap text-[10px]">
                  <span v-if="sw.uplink_count > 0" class="inline-flex items-center gap-1 font-semibold text-blue-600 bg-blue-500/10 px-1.5 py-0.5 rounded">
                    <Icon icon="ph:arrow-fat-up-fill" class="w-2.5 h-2.5" />
                    {{ sw.uplink_count }} Uplink{{ sw.uplink_count > 1 ? 's' : '' }}
                  </span>
                  <span v-if="sw.optical_warnings > 0" class="inline-flex items-center gap-1 font-semibold text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    <Icon icon="carbon:warning-filled" class="w-2.5 h-2.5" />
                    {{ sw.optical_warnings }} Optic Alert{{ sw.optical_warnings > 1 ? 's' : '' }}
                  </span>
                  <span v-else class="inline-flex items-center gap-0.5 text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                    <Icon icon="carbon:checkmark" class="w-2.5 h-2.5 text-emerald-500" />
                    Optics OK
                  </span>
                  <span
                    v-if="sw.telemetry_mode === 'grpc' || sw.is_live_grpc"
                    class="inline-flex items-center gap-0.5 font-bold text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded"
                  >
                    <Icon icon="carbon:flash" class="w-2.5 h-2.5 text-emerald-600" />
                    gRPC
                  </span>
                  <span v-else class="inline-flex items-center gap-0.5 text-zinc-500 bg-zinc-500/10 px-1.5 py-0.5 rounded">
                    <Icon icon="carbon:terminal" class="w-2.5 h-2.5" />
                    SSH
                  </span>
                </div>
              </div>

              <!-- Card Actions Bottom Row -->
              <div class="pt-2 border-t flex items-center justify-between text-xs" @click.stop>
                <div class="text-[10px] text-muted-foreground font-mono truncate max-w-[110px]" :title="sw.inventory_tag || ''">
                  {{ sw.inventory_tag || 'NO-TAG' }}
                </div>
                <div class="flex items-center gap-1">
                  <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-primary" title="SSH Terminal" @click.stop="openSshConsole(sw)">
                    <Icon icon="carbon:terminal" class="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" title="Poll Switch via SSH" :disabled="syncingId === sw.id" @click.stop="syncSwitch(sw.id, $event)">
                    <Icon icon="lucide:refresh-cw" class="w-4 h-4" :class="syncingId === sw.id ? 'animate-spin text-primary' : ''" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" title="Edit Switch Profile" @click.stop="openEditModal(sw)">
                    <Icon icon="carbon:edit" class="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="outline" class="h-8 text-xs font-semibold px-2.5" @click="router.push(`/fleet/${sw.id}`)">
                    Manage
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <!-- VIEW 2: CLASSIC DESKTOP TABLE VIEW -->
          <div v-else class="border rounded-xl bg-card overflow-hidden shadow-xs">
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse text-xs">
                <thead>
                  <tr class="border-b bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider select-none">
                    <!-- Status -->
                    <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('status')">
                      <div class="flex items-center gap-1">
                        <span>Status</span>
                        <Icon v-if="sortKey === 'status'" :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" class="w-3 h-3 text-primary" />
                      </div>
                    </th>

                    <!-- Hostname -->
                    <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('hostname')">
                      <div class="flex items-center gap-1">
                        <span>Switch Hostname</span>
                        <Icon v-if="sortKey === 'hostname'" :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" class="w-3 h-3 text-primary" />
                      </div>
                    </th>

                    <!-- Group Column -->
                    <th class="py-2.5 px-3">Group</th>

                    <!-- IP -->
                    <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('ip')">
                      <div class="flex items-center gap-1">
                        <span>Management IP</span>
                        <Icon v-if="sortKey === 'ip'" :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" class="w-3 h-3 text-primary" />
                      </div>
                    </th>

                    <th class="py-2.5 px-3">Model</th>

                    <!-- Ports -->
                    <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('ports')">
                      <div class="flex items-center gap-1">
                        <span>Interfaces</span>
                        <Icon v-if="sortKey === 'ports'" :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" class="w-3 h-3 text-primary" />
                      </div>
                    </th>

                    <!-- Optical -->
                    <th class="py-2.5 px-3 cursor-pointer hover:text-foreground transition-colors" @click="toggleSort('optical')">
                      <div class="flex items-center gap-1">
                        <span>Telemetry & Optics</span>
                        <Icon v-if="sortKey === 'optical'" :icon="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" class="w-3 h-3 text-primary" />
                      </div>
                    </th>

                    <th class="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr
                    v-for="sw in (groupBy !== 'none' ? section.switches : paginatedSwitches)"
                    :key="sw.id"
                    class="hover:bg-muted/30 transition-colors cursor-pointer group"
                    @click="router.push(`/fleet/${sw.id}`)"
                  >
                    <!-- Status & Last seen -->
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

                    <!-- Switch Group -->
                    <td class="py-2 px-3">
                      <span
                        v-if="sw.group_name"
                        class="text-[10px] font-semibold px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 whitespace-nowrap"
                      >
                        {{ sw.group_name }}
                      </span>
                      <span v-else class="text-[10px] text-muted-foreground">—</span>
                    </td>

                    <!-- Management IP -->
                    <td class="py-2 px-3 font-mono font-bold text-xs whitespace-nowrap text-foreground">
                      <div class="flex items-center gap-1">
                        <span>{{ sw.mgmt_ip || '-' }}</span>
                        <button
                          @click.stop="copyIp(sw.mgmt_ip, $event)"
                          class="p-0.5 hover:text-primary text-muted-foreground opacity-60 hover:opacity-100 rounded"
                          title="Copy IP"
                        >
                          <Icon :icon="copiedIp === sw.mgmt_ip ? 'lucide:check' : 'lucide:copy'" class="w-3 h-3" :class="copiedIp === sw.mgmt_ip ? 'text-emerald-500' : ''" />
                        </button>
                      </div>
                    </td>

                    <!-- Model -->
                    <td class="py-2 px-3">
                      <div class="text-xs font-medium">{{ sw.model_id || 'Ruijie Switch' }}</div>
                      <div class="text-[10px] text-muted-foreground truncate max-w-[130px]">
                        {{ sw.software_version ? sw.software_version.replace(/RGOS\s*/i, '') : 'RGOS' }}
                      </div>
                    </td>

                    <!-- Interfaces & Uplinks -->
                    <td class="py-2 px-3 whitespace-nowrap">
                      <div class="flex items-center gap-1.5">
                        <span class="font-mono text-xs font-medium">
                          <span :class="sw.active_ports > 0 ? 'text-emerald-600 font-bold' : 'text-zinc-500'">{{ sw.active_ports }}</span>/{{ sw.total_ports || '—' }} Up
                        </span>
                        <span v-if="sw.uplink_count > 0" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-blue-600 bg-blue-500/10 px-1.5 py-0.2 rounded">
                          <Icon icon="ph:arrow-fat-up-fill" class="w-2.5 h-2.5" />
                          {{ sw.uplink_count }}
                        </span>
                      </div>
                    </td>

                    <!-- Diagnostics & Telemetry -->
                    <td class="py-2 px-3 whitespace-nowrap">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span
                          v-if="sw.telemetry_mode === 'grpc' || sw.is_live_grpc"
                          class="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.2 rounded-full"
                        >
                          <Icon icon="carbon:flash" class="w-2.5 h-2.5 text-emerald-600" />
                          gRPC
                        </span>
                        <span
                          v-else
                          class="inline-flex items-center gap-0.5 text-[10px] font-medium text-zinc-500 bg-zinc-500/10 border border-zinc-500/20 px-1.5 py-0.2 rounded-full"
                        >
                          <Icon icon="carbon:terminal" class="w-2.5 h-2.5" />
                          SSH
                        </span>

                        <span v-if="sw.optical_warnings > 0" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-600 bg-amber-500/10 px-1.5 py-0.2 rounded">
                          <Icon icon="carbon:warning-filled" class="w-2.5 h-2.5" />
                          Optic Warn
                        </span>
                        <span v-else class="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Icon icon="carbon:checkmark" class="w-2.5 h-2.5 text-emerald-500" />
                          Optics OK
                        </span>
                      </div>
                    </td>

                    <!-- Actions -->
                    <td class="py-2 px-3 text-right whitespace-nowrap" @click.stop>
                      <div class="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          class="h-7 w-7 text-muted-foreground hover:text-primary"
                          title="SSH Terminal Console"
                          @click.stop="openSshConsole(sw)"
                        >
                          <Icon icon="carbon:terminal" class="w-3.5 h-3.5" />
                        </Button>
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
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination Bar (When Flat List is active) -->
      <div
        v-if="groupBy === 'none' && filteredSwitches.length > 0"
        class="p-3 border rounded-xl bg-card flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground select-none"
      >
        <div class="flex items-center gap-2 flex-wrap">
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

    <!-- Switch Group Management Modal -->
    <div
      v-if="manageGroupsModalOpen"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      @click.self="manageGroupsModalOpen = false"
    >
      <div class="bg-card text-card-foreground border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <!-- Modal Header -->
        <div class="p-5 border-b flex items-center justify-between bg-muted/30">
          <div>
            <h3 class="text-base font-bold flex items-center gap-2">
              <Icon icon="carbon:folder-shared" class="w-5 h-5 text-primary" />
              Manage Switch Groups
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Create and manage groups (e.g. buildings, rack locations, or departments).
            </p>
          </div>
          <button @click="manageGroupsModalOpen = false" class="text-muted-foreground hover:text-foreground p-1">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-sm">
          <div v-if="groupError" class="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg flex items-center gap-2">
            <Icon icon="lucide:alert-circle" class="w-4 h-4 shrink-0" />
            <span>{{ groupError }}</span>
          </div>

          <!-- Section: Create New Group -->
          <div class="bg-muted/30 border rounded-xl p-3.5">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Icon icon="lucide:plus" class="w-3.5 h-3.5 text-primary" />
              Add New Group
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
              <div>
                <label class="text-xs font-semibold block mb-1">Group Name <span class="text-destructive">*</span></label>
                <Input
                  v-model="newGroupName"
                  placeholder="e.g. Gedung Z, Core Rack"
                  class="text-xs bg-background"
                  @keyup.enter="createGroup"
                />
              </div>
              <div>
                <label class="text-xs font-semibold block mb-1">Description (Optional)</label>
                <Input
                  v-model="newGroupDesc"
                  placeholder="e.g. Lantai 1-4 switch stack"
                  class="text-xs bg-background"
                  @keyup.enter="createGroup"
                />
              </div>
            </div>
            <div class="flex justify-end">
              <Button size="sm" class="h-8 text-xs font-semibold" @click="createGroup" :disabled="groupSaving">
                <Icon icon="lucide:plus" class="w-3.5 h-3.5 mr-1" />
                {{ groupSaving ? 'Adding...' : 'Create Group' }}
              </Button>
            </div>
          </div>

          <!-- Section: Existing Groups List -->
          <div>
            <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Icon icon="carbon:category" class="w-3.5 h-3.5 text-primary" />
              Existing Groups ({{ groups.length }})
            </h4>

            <div v-if="groups.length === 0" class="text-center py-6 text-muted-foreground border rounded-xl border-dashed">
              <Icon icon="carbon:folder-off" class="w-8 h-8 mx-auto mb-1.5 opacity-40" />
              <p class="text-xs font-medium">No switch groups defined yet.</p>
              <p class="text-[11px] mt-0.5 text-muted-foreground">Add your first group above to start organizing your 38+ switches.</p>
            </div>

            <div v-else class="divide-y border rounded-xl overflow-hidden bg-card">
              <div
                v-for="g in groups"
                :key="g.id"
                class="p-3 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors"
              >
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-xs text-foreground">{{ g.name }}</span>
                    <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {{ g.count }} {{ g.count === 1 ? 'switch' : 'switches' }}
                    </span>
                  </div>
                  <p v-if="g.description" class="text-[11px] text-muted-foreground truncate mt-0.5">
                    {{ g.description }}
                  </p>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                  title="Delete group"
                  @click="deleteGroup(g)"
                >
                  <Icon icon="lucide:trash-2" class="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="p-3.5 border-t flex items-center justify-end bg-muted/30">
          <Button variant="outline" size="sm" @click="manageGroupsModalOpen = false">
            Close
          </Button>
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
              <label class="text-xs font-semibold block mb-1">Switch Group</label>
              <select
                v-model="addForm.group_name"
                class="w-full border rounded-md px-3 py-2 text-xs bg-background text-foreground h-9"
              >
                <option value="">(None / Ungrouped)</option>
                <option v-for="g in groups" :key="g.id" :value="g.name">
                  {{ g.name }}
                </option>
              </select>
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
              <Icon icon="carbon:settings-adjust" class="w-5 h-5 text-primary" />
              Global Fleet Configuration
            </h3>
            <p class="text-xs text-muted-foreground mt-0.5">
              Batch configuration and maintenance operations across the entire switch fleet.
            </p>
          </div>
          <button @click="globalModalOpen = false" class="text-muted-foreground hover:text-foreground">
            <Icon icon="lucide:x" class="w-5 h-5" />
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-5 space-y-4 text-sm max-h-[75vh] overflow-y-auto">
          <!-- Action 1: Deploy Clean gRPC Configuration -->
          <div class="p-4 border rounded-xl bg-card space-y-3">
            <div class="flex items-center gap-2 font-semibold">
              <Icon icon="carbon:flash" class="w-4 h-4 text-emerald-500" />
              Deploy Telemetry Preset to Fleet
            </div>
            <p class="text-xs text-muted-foreground">
              Deploys a minimal, reliable gRPC telemetry configuration to all online switches.
            </p>
            <div class="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label class="text-xs font-semibold text-muted-foreground block mb-1">Collector Server IP</label>
                <Input
                  v-model="grpcServerIp"
                  placeholder="e.g. 10.23.9.10"
                  class="font-mono text-xs"
                  :disabled="globalRunning"
                />
              </div>
              <div>
                <label class="text-xs font-semibold text-muted-foreground block mb-1">gRPC Port</label>
                <Input
                  v-model="grpcServerPort"
                  type="number"
                  placeholder="50051"
                  class="font-mono text-xs"
                  :disabled="globalRunning"
                />
              </div>
            </div>
            <div class="flex items-center justify-end pt-2">
              <Button
                size="sm"
                variant="outline"
                class="border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 text-xs"
                :disabled="globalRunning"
                @click="deployGrpcGlobal"
              >
                <Icon icon="carbon:send-alt" class="w-3.5 h-3.5 mr-1.5" />
                Deploy Preset to Fleet
              </Button>
            </div>
          </div>

          <!-- Action 2: Trigger Running-Config Backup Sync -->
          <div class="p-4 border rounded-xl bg-card space-y-3">
            <div class="flex items-center gap-2 font-semibold">
              <Icon icon="carbon:cloud-download" class="w-4 h-4 text-primary" />
              Sync Running-Config for All Switches
            </div>
            <p class="text-xs text-muted-foreground">
              Queues a background SSH job to fetch the latest running-config from all switches.
            </p>
            <div class="flex items-center justify-end pt-1">
              <Button
                size="sm"
                variant="outline"
                class="text-xs"
                :disabled="globalRunning"
                @click="syncConfigGlobal"
              >
                <Icon icon="lucide:refresh-cw" class="w-3.5 h-3.5 mr-1.5" />
                Enqueue Config Sync
              </Button>
            </div>
          </div>

          <!-- Status Message -->
          <div v-if="globalStatus" class="p-3 bg-muted/50 rounded-lg text-xs font-mono text-muted-foreground flex items-center gap-2">
            <Icon v-if="globalRunning" icon="lucide:loader-2" class="w-4 h-4 animate-spin text-primary shrink-0" />
            <Icon v-else icon="carbon:information" class="w-4 h-4 text-primary shrink-0" />
            <span>{{ globalStatus }}</span>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="p-4 border-t flex items-center justify-end bg-muted/30">
          <Button variant="outline" size="sm" @click="globalModalOpen = false" :disabled="globalRunning">
            Close
          </Button>
        </div>
      </div>
    </div>

    <!-- Edit Switch Modal -->
    <EditSwitchModal
      v-model:open="editModalOpen"
      :switch-data="switchBeingEdited"
      :hardware-models="hardwareModels"
      @saved="handleSwitchSaved"
      @deleted="handleSwitchDeleted"
    />

    <!-- SSH Console Modal -->
    <SshConsoleModal
      v-model:open="sshModalOpen"
      :switch-data="sshConsoleSwitch"
    />

    <!-- Batch SSH Modal -->
    <BatchSshModal
      v-model:open="batchModalOpen"
      :switches="switches"
    />
  </div>
</template>