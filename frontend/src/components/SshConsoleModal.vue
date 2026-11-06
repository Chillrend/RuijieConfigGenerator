<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { io } from 'socket.io-client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Icon } from '@iconify/vue'
import { Button } from './ui/button'
import { Badge } from './ui/badge'

const props = defineProps({
  open: { type: Boolean, required: true },
  switchData: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['update:open'])

const terminalContainer = ref(null)
const status = ref('disconnected') // 'connecting' | 'connected' | 'disconnected' | 'error'
const errorMessage = ref('')

let term = null
let fitAddon = null
let socket = null
let resizeObserver = null

const initSession = async () => {
  if (!props.open || !props.switchData?.id) return

  await nextTick()
  if (!terminalContainer.value) return

  cleanupSession()

  status.value = 'connecting'
  errorMessage.value = ''

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.25,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: {
      background: '#090d16',
      foreground: '#f1f5f9',
      cursor: '#38bdf8',
      selectionBackground: '#334155',
      black: '#0f172a',
      red: '#f43f5e',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#3b82f6',
      magenta: '#d946ef',
      cyan: '#06b6d4',
      white: '#f8fafc',
      brightBlack: '#64748b',
      brightRed: '#fb7185',
      brightGreen: '#34d399',
      brightYellow: '#fbbf24',
      brightBlue: '#60a5fa',
      brightMagenta: '#e879f9',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff'
    }
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalContainer.value)

  setTimeout(() => {
    try {
      fitAddon.fit()
    } catch (e) {}
  }, 50)

  socket = io(window.location.origin, {
    transports: ['websocket', 'polling'],
    withCredentials: true
  })

  socket.on('connect', () => {
    socket.emit('ssh:init', {
      switchId: props.switchData.id,
      cols: term.cols || 80,
      rows: term.rows || 24
    })
  })

  socket.on('ssh:ready', () => {
    status.value = 'connected'
    term.focus()
  })

  socket.on('ssh:data', (data) => {
    term.write(data)
  })

  socket.on('ssh:error', (err) => {
    status.value = 'error'
    errorMessage.value = err
    term.writeln(`\r\n\x1b[31;1m[SSH Connection Error]: ${err}\x1b[0m\r\n`)
  })

  socket.on('ssh:close', () => {
    if (status.value === 'connected') {
      status.value = 'disconnected'
      term.writeln('\r\n\x1b[33;1m[SSH session closed by remote switch]\x1b[0m\r\n')
    }
  })

  term.onData((data) => {
    if (socket && status.value === 'connected') {
      socket.emit('ssh:data', data)
    }
  })

  const handleResize = () => {
    if (!fitAddon || !term || !socket || status.value !== 'connected') return
    try {
      fitAddon.fit()
      socket.emit('ssh:resize', { cols: term.cols, rows: term.rows })
    } catch (e) {}
  }

  resizeObserver = new ResizeObserver(() => handleResize())
  if (terminalContainer.value) {
    resizeObserver.observe(terminalContainer.value)
  }
}

const cleanupSession = () => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (socket) {
    socket.emit('ssh:close')
    socket.disconnect()
    socket = null
  }
  if (term) {
    term.dispose()
    term = null
  }
  fitAddon = null
  status.value = 'disconnected'
}

const clearTerminal = () => {
  if (term) term.clear()
}

const reconnect = () => {
  initSession()
}

const closeModal = () => {
  cleanupSession()
  emit('update:open', false)
}

watch(
  () => props.open,
  (newVal) => {
    if (newVal) {
      initSession()
    } else {
      cleanupSession()
    }
  }
)

onUnmounted(() => {
  cleanupSession()
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    @click.self="closeModal"
  >
    <div
      class="bg-card text-card-foreground border border-border rounded-2xl w-full max-w-5xl h-[88vh] shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      <!-- Modal Header -->
      <div class="px-5 py-3 border-b flex items-center justify-between bg-muted/40 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Icon icon="carbon:terminal" class="w-4 h-4" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-bold text-foreground">
                {{ switchData?.hostname || 'Switch Console' }}
              </h3>
              <span class="text-xs font-mono text-muted-foreground">({{ switchData?.mgmt_ip || 'No IP' }})</span>
              <Badge
                v-if="status === 'connected'"
                variant="outline"
                class="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px] px-2 py-0 h-4.5 font-medium flex items-center gap-1"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                Connected
              </Badge>
              <Badge
                v-else-if="status === 'connecting'"
                variant="outline"
                class="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px] px-2 py-0 h-4.5 font-medium flex items-center gap-1"
              >
                <Icon icon="lucide:loader-2" class="w-2.5 h-2.5 animate-spin" />
                Connecting...
              </Badge>
              <Badge
                v-else-if="status === 'error'"
                variant="outline"
                class="bg-rose-500/10 text-rose-600 border-rose-500/20 text-[10px] px-2 py-0 h-4.5 font-medium"
              >
                Error
              </Badge>
              <Badge
                v-else
                variant="outline"
                class="bg-muted text-muted-foreground text-[10px] px-2 py-0 h-4.5 font-medium"
              >
                Disconnected
              </Badge>
            </div>
            <p class="text-[11px] text-muted-foreground">
              User: <span class="font-mono text-foreground">{{ switchData?.admin_username || 'admin' }}</span> &middot; Port 22 SSH Direct Console
            </p>
          </div>
        </div>

        <!-- Header Actions -->
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            class="h-7 text-xs text-muted-foreground hover:text-foreground"
            title="Clear Console Buffer"
            @click="clearTerminal"
          >
            <Icon icon="carbon:clean" class="w-3.5 h-3.5 mr-1" />
            Clear
          </Button>

          <Button
            variant="ghost"
            size="sm"
            class="h-7 text-xs text-muted-foreground hover:text-foreground"
            title="Reconnect SSH Session"
            :disabled="status === 'connecting'"
            @click="reconnect"
          >
            <Icon icon="lucide:refresh-cw" class="w-3.5 h-3.5 mr-1" :class="status === 'connecting' ? 'animate-spin' : ''" />
            Reconnect
          </Button>

          <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 text-muted-foreground hover:text-foreground ml-1"
            @click="closeModal"
          >
            <Icon icon="lucide:x" class="w-4 h-4" />
          </Button>
        </div>
      </div>

      <!-- Terminal Body -->
      <div class="relative flex-1 bg-[#090d16] p-2 overflow-hidden flex flex-col">
        <div ref="terminalContainer" class="w-full h-full flex-1"></div>
      </div>

      <!-- Footer Info Bar -->
      <div class="px-4 py-2 border-t bg-muted/20 flex items-center justify-between text-[11px] text-muted-foreground shrink-0">
        <div class="flex items-center gap-2">
          <Icon icon="lucide:info" class="w-3.5 h-3.5 text-primary" />
          <span>Supports full keyboard navigation, VT100 sequences, Tab autocompletion, and copy/paste.</span>
        </div>
        <div class="font-mono text-[10px]">
          xterm-256color &middot; WebSockets
        </div>
      </div>
    </div>
  </div>
</template>