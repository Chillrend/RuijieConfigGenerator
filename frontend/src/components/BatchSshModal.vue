<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { io } from 'socket.io-client'
import { Icon } from '@iconify/vue'
import { Button } from './ui/button'
import { Badge } from './ui/badge'

const props = defineProps({
  open: { type: Boolean, required: true },
  switches: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:open', 'completed'])

const commandsText = ref('')
const saveConfig = ref(true)
const targetMode = ref('online') // 'online' | 'all' | 'custom'
const selectedIds = ref([])
const running = ref(false)
const statusText = ref('')
const progress = ref({ completed: 0, total: 0, current: '' })
const results = ref(null)
const expandedOutputs = ref({})

let socket = null

const onlineSwitches = computed(() => {
  return props.switches.filter(s => s.status === 'online')
})

const targetSwitches = computed(() => {
  if (targetMode.value === 'online') return onlineSwitches.value
  if (targetMode.value === 'all') return props.switches
  const set = new Set(selectedIds.value)
  return props.switches.filter(s => set.has(s.id))
})

const parsedLines = computed(() => {
  return commandsText.value
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('!'))
})

const toggleSelectAll = () => {
  if (selectedIds.value.length === props.switches.length) {
    selectedIds.value = []
  } else {
    selectedIds.value = props.switches.map(s => s.id)
  }
}

const toggleOutput = (id) => {
  expandedOutputs.value[id] = !expandedOutputs.value[id]
}

const setupSocket = () => {
  if (socket) socket.disconnect()
  socket = io(window.location.origin, {
    transports: ['websocket', 'polling'],
    withCredentials: true
  })

  socket.on('global-action:progress', (data) => {
    if (running.value && data.action === 'batch-push') {
      progress.value = data
      statusText.value = `[${data.completed}/${data.total}] Executing commands on ${data.current || 'switch'}...`
    }
  })
}

const closeModal = () => {
  if (running.value) return
  emit('update:open', false)
}

const executeBatchPush = async () => {
  if (parsedLines.value.length === 0) {
    alert('Please enter at least one CLI command to push.')
    return
  }

  const targets = targetSwitches.value
  if (targets.length === 0) {
    alert('No target switches selected.')
    return
  }

  const confirmMsg = `Are you sure you want to push ${parsedLines.value.length} command(s) to ${targets.length} switch(es)?\n\nExecution sequence starts after: "configure terminal"`
  if (!confirm(confirmMsg)) return

  running.value = true
  statusText.value = `Initiating batch SSH push across ${targets.length} switches...`
  progress.value = { completed: 0, total: targets.length, current: '' }
  results.value = null
  expandedOutputs.value = {}

  try {
    const res = await fetch('/api/fleet/global-config/batch-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        commands: commandsText.value,
        switchIds: targets.map(s => s.id),
        saveConfig: saveConfig.value
      })
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Batch push failed')

    results.value = data
    statusText.value = `Finished: ${data.successful} succeeded, ${data.failed} failed.`
    emit('completed', data)
  } catch (err) {
    statusText.value = `Error: ${err.message}`
  } finally {
    running.value = false
  }
}

watch(
  () => props.open,
  (newVal) => {
    if (newVal) {
      statusText.value = ''
      results.value = null
      progress.value = { completed: 0, total: 0, current: '' }
      selectedIds.value = onlineSwitches.value.map(s => s.id)
      setupSocket()
    } else {
      if (socket) {
        socket.disconnect()
        socket = null
      }
    }
  }
)

onUnmounted(() => {
  if (socket) socket.disconnect()
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    @click.self="closeModal"
  >
    <div
      class="bg-card text-card-foreground border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      <!-- Modal Header -->
      <div class="px-5 py-4 border-b flex items-center justify-between bg-muted/30 shrink-0">
        <div>
          <h3 class="text-base font-bold flex items-center gap-2">
            <Icon icon="carbon:terminal" class="w-5 h-5 text-primary" />
            Batch Push SSH Commands
          </h3>
          <p class="text-xs text-muted-foreground mt-0.5">
            Remotely execute arbitrary configuration commands across fleet switches.
          </p>
        </div>
        <button
          @click="closeModal"
          class="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
          :disabled="running"
        >
          <Icon icon="lucide:x" class="w-5 h-5" />
        </button>
      </div>

      <!-- Modal Body -->
      <div class="p-5 space-y-4 overflow-y-auto flex-1 text-sm">
        <!-- Sequence Info Banner -->
        <div class="p-3.5 bg-primary/10 border border-primary/20 text-xs rounded-xl flex items-start gap-2.5">
          <Icon icon="lucide:info" class="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <div class="space-y-1">
            <p class="font-medium text-foreground">
              Automatic Configuration Enclosure
            </p>
            <p class="text-muted-foreground leading-relaxed">
              All entered commands are automatically initiated after entering <span class="font-mono font-semibold text-primary">configure terminal</span>.
              The session automatically concludes with <span class="font-mono font-semibold text-primary">end</span> and commits with <span class="font-mono font-semibold text-primary">write</span>.
            </p>
          </div>
        </div>

        <!-- Target Selection Section -->
        <div class="p-4 rounded-xl border bg-muted/20 space-y-3">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-foreground uppercase tracking-wider">
              1. Select Target Switches
            </label>
            <span class="text-xs font-mono text-muted-foreground">
              {{ targetSwitches.length }} switch(es) targeted
            </span>
          </div>

          <div class="grid grid-cols-3 gap-2">
            <button
              type="button"
              class="px-3 py-2 text-xs font-medium rounded-lg border text-left transition-colors flex items-center justify-between"
              :class="targetMode === 'online' ? 'bg-primary/10 border-primary text-primary' : 'bg-background hover:bg-muted/50 border-border text-foreground'"
              :disabled="running"
              @click="targetMode = 'online'"
            >
              <span>Online Only</span>
              <Badge variant="outline" class="text-[10px]">{{ onlineSwitches.length }}</Badge>
            </button>

            <button
              type="button"
              class="px-3 py-2 text-xs font-medium rounded-lg border text-left transition-colors flex items-center justify-between"
              :class="targetMode === 'all' ? 'bg-primary/10 border-primary text-primary' : 'bg-background hover:bg-muted/50 border-border text-foreground'"
              :disabled="running"
              @click="targetMode = 'all'"
            >
              <span>All Switches</span>
              <Badge variant="outline" class="text-[10px]">{{ switches.length }}</Badge>
            </button>

            <button
              type="button"
              class="px-3 py-2 text-xs font-medium rounded-lg border text-left transition-colors flex items-center justify-between"
              :class="targetMode === 'custom' ? 'bg-primary/10 border-primary text-primary' : 'bg-background hover:bg-muted/50 border-border text-foreground'"
              :disabled="running"
              @click="targetMode = 'custom'"
            >
              <span>Custom Selection</span>
              <Badge variant="outline" class="text-[10px]">{{ selectedIds.length }}</Badge>
            </button>
          </div>

          <!-- Custom Selection Switch List -->
          <div v-if="targetMode === 'custom'" class="pt-2 border-t border-border/50 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="text-muted-foreground">Pick specific switches:</span>
              <button type="button" class="text-primary hover:underline font-medium" @click="toggleSelectAll">
                {{ selectedIds.length === switches.length ? 'Deselect All' : 'Select All' }}
              </button>
            </div>
            <div class="max-h-36 overflow-y-auto border rounded-lg bg-background p-2 grid grid-cols-2 gap-1.5">
              <label
                v-for="sw in switches"
                :key="sw.id"
                class="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 cursor-pointer text-xs"
              >
                <input
                  type="checkbox"
                  :value="sw.id"
                  v-model="selectedIds"
                  :disabled="running"
                  class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <span class="font-medium truncate">{{ sw.hostname || 'Switch #' + sw.id }}</span>
                <span class="font-mono text-muted-foreground text-[11px]">({{ sw.mgmt_ip }})</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Commands Input Section -->
        <div class="p-4 rounded-xl border bg-muted/20 space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-foreground uppercase tracking-wider">
              2. Configuration Commands
            </label>
            <span class="text-xs text-muted-foreground">
              {{ parsedLines.length }} command line(s)
            </span>
          </div>

          <!-- Code Box Frame with Prefix / Suffix indicators -->
          <div class="border rounded-xl bg-[#090d16] text-[#f1f5f9] font-mono text-xs overflow-hidden shadow-inner">
            <!-- Prefix Line -->
            <div class="px-3.5 py-1.5 bg-[#0f172a] border-b border-white/10 text-emerald-400 font-semibold flex items-center justify-between select-none">
              <span class="flex items-center gap-1.5">
                <Icon icon="carbon:arrow-right" class="w-3.5 h-3.5" />
                configure terminal
              </span>
              <span class="text-[10px] text-muted-foreground font-normal italic">automatically executed first</span>
            </div>

            <!-- Command Textarea -->
            <textarea
              v-model="commandsText"
              rows="6"
              :disabled="running"
              placeholder="vlan 200&#10; name Guest-WiFi&#10;interface GigabitEthernet 0/1&#10; description Uplink to Router"
              class="w-full bg-transparent p-3.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-hidden resize-y font-mono leading-relaxed"
            ></textarea>

            <!-- Suffix Lines -->
            <div class="px-3.5 py-1.5 bg-[#0f172a] border-t border-white/10 text-blue-400 font-semibold flex items-center justify-between select-none">
              <span class="flex items-center gap-1.5">
                <Icon icon="carbon:checkmark" class="w-3.5 h-3.5" />
                end {{ saveConfig ? '&& write' : '' }}
              </span>
              <span class="text-[10px] text-muted-foreground font-normal italic">
                {{ saveConfig ? 'commits configuration to startup NVRAM' : 'exits config mode without saving' }}
              </span>
            </div>
          </div>

          <!-- Option: Commit / Write -->
          <div class="flex items-center gap-2 pt-1">
            <input
              id="saveConfigCheck"
              type="checkbox"
              v-model="saveConfig"
              :disabled="running"
              class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
            />
            <label for="saveConfigCheck" class="text-xs text-muted-foreground cursor-pointer select-none">
              Save running-config to startup memory (<span class="font-mono">write</span>) upon completion
            </label>
          </div>
        </div>

        <!-- Progress Indicator -->
        <div v-if="running || statusText" class="p-3.5 rounded-xl border bg-card space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-medium text-foreground flex items-center gap-1.5">
              <Icon v-if="running" icon="lucide:loader-2" class="w-3.5 h-3.5 animate-spin text-primary" />
              <Icon v-else-if="results?.failed === 0" icon="carbon:checkmark-filled" class="w-4 h-4 text-emerald-500" />
              <Icon v-else icon="carbon:warning-filled" class="w-4 h-4 text-amber-500" />
              {{ statusText }}
            </span>
            <span v-if="progress.total > 0" class="font-mono text-muted-foreground">
              {{ progress.completed }} / {{ progress.total }}
            </span>
          </div>

          <!-- Progress Bar -->
          <div v-if="running && progress.total > 0" class="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              class="bg-primary h-2 transition-all duration-300 rounded-full"
              :style="{ width: `${(progress.completed / progress.total) * 100}%` }"
            ></div>
          </div>
        </div>

        <!-- Execution Results Drawer -->
        <div v-if="results" class="border rounded-xl overflow-hidden bg-card space-y-2">
          <div class="p-3 border-b bg-muted/30 flex items-center justify-between text-xs font-semibold">
            <span>Execution Summary</span>
            <div class="flex items-center gap-2 font-mono text-[11px]">
              <span class="text-emerald-600 font-bold">{{ results.successful }} OK</span>
              <span>&middot;</span>
              <span class="text-rose-600 font-bold">{{ results.failed }} Failed</span>
            </div>
          </div>

          <div class="divide-y divide-border/60 max-h-60 overflow-y-auto">
            <div
              v-for="res in results.results"
              :key="res.id"
              class="p-2.5 hover:bg-muted/20 text-xs space-y-1.5"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-foreground">{{ res.hostname || 'Switch #' + res.id }}</span>
                  <span class="font-mono text-muted-foreground text-[11px]">{{ res.mgmt_ip }}</span>
                </div>
                <div class="flex items-center gap-2">
                  <Badge
                    :variant="res.status === 'success' ? 'default' : 'destructive'"
                    class="text-[10px] h-5"
                    :class="res.status === 'success' ? 'bg-emerald-600' : ''"
                  >
                    {{ res.status === 'success' ? 'Success' : 'Failed' }}
                  </Badge>
                  <Button
                    v-if="res.output || res.error"
                    variant="ghost"
                    size="sm"
                    class="h-6 text-[10px] px-1.5 text-muted-foreground hover:text-foreground"
                    @click="toggleOutput(res.id)"
                  >
                    {{ expandedOutputs[res.id] ? 'Hide Log' : 'View Log' }}
                  </Button>
                </div>
              </div>

              <!-- Output Box if expanded -->
              <div
                v-if="expandedOutputs[res.id]"
                class="mt-2 p-2.5 rounded-lg bg-[#090d16] text-[#f1f5f9] font-mono text-[11px] whitespace-pre-wrap max-h-48 overflow-y-auto"
              >
                <div v-if="res.error" class="text-rose-400 font-bold mb-1">
                  Error: {{ res.error }}
                </div>
                <div>{{ res.output || '(No console output captured)' }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="px-5 py-3.5 border-t flex items-center justify-between bg-muted/30 shrink-0">
        <span class="text-xs text-muted-foreground">
          Targeting <strong class="text-foreground">{{ targetSwitches.length }}</strong> devices
        </span>

        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            @click="closeModal"
            :disabled="running"
          >
            {{ results ? 'Done' : 'Cancel' }}
          </Button>

          <Button
            size="sm"
            class="bg-primary text-primary-foreground font-medium"
            :disabled="running || parsedLines.length === 0 || targetSwitches.length === 0"
            @click="executeBatchPush"
          >
            <Icon
              :icon="running ? 'lucide:loader-2' : 'lucide:play'"
              class="w-3.5 h-3.5 mr-1.5"
              :class="running ? 'animate-spin' : ''"
            />
            {{ running ? 'Pushing Commands...' : `Push to ${targetSwitches.length} Switches` }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>