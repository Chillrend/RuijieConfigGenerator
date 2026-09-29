<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'

const router = useRouter()
const switches = ref([])
const hardwareModels = ref([])
const loading = ref(true)
const syncingAll = ref(false)
const syncingId = ref(null)
const searchQuery = ref('')
const errorMsg = ref('')

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

const stats = computed(() => {
  const total = switches.value.length
  const online = switches.value.filter(s => s.status === 'online').length
  const offline = switches.value.filter(s => s.status === 'offline').length
  const opticalIssues = switches.value.filter(s => s.optical_warnings > 0).length
  return { total, online, offline, opticalIssues }
})

onMounted(() => {
  fetchFleet()
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
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <th class="py-3 px-4">Status</th>
              <th class="py-3 px-4">Switch Hostname</th>
              <th class="py-3 px-4">Management IP</th>
              <th class="py-3 px-4">Model & Firmware</th>
              <th class="py-3 px-4 text-center">Active Ports</th>
              <th class="py-3 px-4 text-center">Uplinks</th>
              <th class="py-3 px-4 text-center">Optical DDM</th>
              <th class="py-3 px-4">Last Seen</th>
              <th class="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr
              v-for="sw in filteredSwitches"
              :key="sw.id"
              class="hover:bg-muted/30 transition-colors cursor-pointer group"
              @click="router.push(`/fleet/${sw.id}`)"
            >
              <!-- Online/Offline Status -->
              <td class="py-3 px-4">
                <div class="flex items-center gap-2">
                  <span
                    class="w-2.5 h-2.5 rounded-full"
                    :class="{
                      'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]': sw.status === 'online',
                      'bg-rose-500': sw.status === 'offline',
                      'bg-amber-400': sw.status === 'error',
                      'bg-zinc-400': sw.status === 'unknown'
                    }"
                  />
                  <span class="text-xs font-medium capitalize" :class="{
                    'text-emerald-600': sw.status === 'online',
                    'text-rose-600': sw.status === 'offline',
                    'text-muted-foreground': sw.status === 'unknown'
                  }">
                    {{ sw.status }}
                  </span>
                </div>
              </td>

              <!-- Hostname & Tag -->
              <td class="py-3 px-4">
                <div class="font-semibold text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                  {{ sw.hostname || 'Unnamed Switch' }}
                </div>
                <div class="text-xs text-muted-foreground flex items-center gap-1.5 font-mono">
                  <span>{{ sw.inventory_tag || 'NO-TAG' }}</span>
                  <span>•</span>
                  <span>SN: {{ sw.serial_number || '-' }}</span>
                </div>
              </td>

              <!-- IP -->
              <td class="py-3 px-4">
                <span class="font-mono text-xs font-medium px-2 py-0.5 rounded bg-muted">
                  {{ sw.mgmt_ip || '-' }}
                </span>
              </td>

              <!-- Model -->
              <td class="py-3 px-4">
                <div class="text-xs font-medium">{{ sw.model_id || 'Ruijie Switch' }}</div>
                <div class="text-[11px] text-muted-foreground truncate max-w-[150px]">
                  {{ sw.software_version || 'RGOS' }}
                </div>
              </td>

              <!-- Ports -->
              <td class="py-3 px-4 text-center">
                <Badge variant="outline" class="font-mono text-xs">
                  {{ sw.active_ports }} / {{ sw.total_ports || '—' }}
                </Badge>
              </td>

              <!-- Uplinks -->
              <td class="py-3 px-4 text-center">
                <div v-if="sw.uplink_count > 0" class="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-full">
                  <Icon icon="ph:arrow-fat-up-fill" class="w-3.5 h-3.5" />
                  <span>{{ sw.uplink_count }} Uplink</span>
                </div>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </td>

              <!-- Optical -->
              <td class="py-3 px-4 text-center">
                <div v-if="sw.optical_warnings > 0" class="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                  <Icon icon="carbon:warning-filled" class="w-3.5 h-3.5" />
                  <span>Warning</span>
                </div>
                <div v-else class="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Icon icon="carbon:circle-dash" class="w-3.5 h-3.5 text-emerald-500" />
                  <span>Normal</span>
                </div>
              </td>

              <!-- Last Seen -->
              <td class="py-3 px-4 text-xs text-muted-foreground">
                <div v-if="sw.last_seen">{{ new Date(sw.last_seen).toLocaleTimeString() }}</div>
                <div v-else class="italic">Never synced</div>
              </td>

              <!-- Action Buttons -->
              <td class="py-3 px-4 text-right" @click.stop>
                <div class="flex items-center justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title="Poll switch via SSH"
                    :disabled="syncingId === sw.id"
                    @click="syncSwitch(sw.id, $event)"
                  >
                    <Icon
                      icon="lucide:refresh-cw"
                      class="w-4 h-4"
                      :class="syncingId === sw.id ? 'animate-spin text-primary' : ''"
                    />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-8 text-xs font-medium"
                    @click="router.push(`/fleet/${sw.id}`)"
                  >
                    Manage
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
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
  </div>
</template>
