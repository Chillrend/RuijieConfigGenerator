<script setup>
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { Input } from './ui/input'
import { Button } from './ui/button'

const props = defineProps({
  open: { type: Boolean, required: true },
  switchData: { type: Object, default: () => ({}) },
  hardwareModels: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:open', 'saved', 'deleted'])

const saving = ref(false)
const deleting = ref(false)
const errorMsg = ref('')
const localModels = ref([])

const form = ref({
  id: null,
  mgmt_ip: '',
  hostname: '',
  inventory_tag: '',
  model_id: '',
  serial_number: '',
  mac_address: '',
  admin_username: 'admin',
  admin_password: '',
  enable_password: ''
})

const loadHardwareModels = async () => {
  if (props.hardwareModels && props.hardwareModels.length > 0) {
    localModels.value = props.hardwareModels
    return
  }
  if (localModels.value.length === 0) {
    try {
      const res = await fetch('/api/setup', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        localModels.value = data.hardware || []
      }
    } catch (e) {}
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      errorMsg.value = ''
      loadHardwareModels()
      const s = props.switchData || {}
      form.value = {
        id: s.id,
        mgmt_ip: s.mgmt_ip || '',
        hostname: s.hostname || '',
        inventory_tag: s.inventory_tag || '',
        model_id: s.model_id || '',
        serial_number: s.serial_number || '',
        mac_address: s.mac_address || '',
        admin_username: s.admin_username || 'admin',
        admin_password: '',
        enable_password: ''
      }
    }
  },
  { immediate: true }
)

const close = () => {
  if (saving.value || deleting.value) return
  emit('update:open', false)
}

const save = async () => {
  if (!form.value.mgmt_ip || !form.value.mgmt_ip.trim()) {
    errorMsg.value = 'Management IP is required.'
    return
  }

  saving.value = true
  errorMsg.value = ''

  try {
    const payload = {
      mgmt_ip: form.value.mgmt_ip.trim(),
      hostname: form.value.hostname.trim(),
      inventory_tag: form.value.inventory_tag.trim(),
      model_id: form.value.model_id.trim(),
      serial_number: form.value.serial_number.trim(),
      mac_address: form.value.mac_address.trim(),
      admin_username: form.value.admin_username.trim()
    }

    if (form.value.admin_password) {
      payload.admin_password = form.value.admin_password
    }
    if (form.value.enable_password) {
      payload.enable_password = form.value.enable_password
    }

    const res = await fetch(`/api/fleet/${form.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to update switch profile')

    emit('saved', { ...props.switchData, ...payload })
    emit('update:open', false)
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    saving.value = false
  }
}

const deleteSwitch = async () => {
  const hostLabel = form.value.hostname || form.value.mgmt_ip || 'this switch'
  if (!confirm(`Are you sure you want to remove ${hostLabel} from the fleet? Historical data and telemetry references for this switch will be removed.`)) {
    return
  }

  deleting.value = true
  errorMsg.value = ''

  try {
    const res = await fetch(`/api/fleet/${form.value.id}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to delete switch')

    emit('deleted', form.value.id)
    emit('update:open', false)
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
    @click.self="close"
  >
    <div
      class="bg-card text-card-foreground border rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      <!-- Modal Header -->
      <div class="p-5 border-b flex items-center justify-between bg-muted/30">
        <div>
          <h3 class="text-base font-bold flex items-center gap-2">
            <Icon icon="carbon:edit" class="w-5 h-5 text-primary" />
            Edit Switch Profile
          </h3>
          <p class="text-xs text-muted-foreground mt-0.5">
            Update management IP, inventory tag, device identity, or SSH credentials.
          </p>
        </div>
        <button
          @click="close"
          class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted"
        >
          <Icon icon="lucide:x" class="w-5 h-5" />
        </button>
      </div>

      <!-- Modal Body -->
      <div class="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-sm">
        <div
          v-if="errorMsg"
          class="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-lg flex items-center gap-2"
        >
          <Icon icon="lucide:alert-circle" class="w-4 h-4 shrink-0" />
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Section 1: Network & Identity -->
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Icon icon="carbon:network-enterprise" class="w-3.5 h-3.5 text-primary" />
            Basic Identity & Management
          </h4>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">
                Management IP <span class="text-destructive">*</span>
              </label>
              <Input
                v-model="form.mgmt_ip"
                placeholder="10.90.x.x"
                class="font-mono text-xs"
                required
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Hostname</label>
              <Input
                v-model="form.hostname"
                placeholder="e.g. SW-ACC-01"
                class="text-xs font-mono"
              />
            </div>
          </div>
        </div>

        <!-- Section 2: Asset & Hardware Metadata -->
        <div>
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Icon icon="carbon:chip" class="w-3.5 h-3.5 text-primary" />
            Hardware & Asset Tracking
          </h4>
          <div class="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Inventory Tag</label>
              <Input
                v-model="form.inventory_tag"
                placeholder="e.g. INV-2026-001"
                class="text-xs font-mono"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Switch Model</label>
              <select
                v-model="form.model_id"
                class="w-full border rounded-md px-3 py-2 text-xs bg-background text-foreground h-9"
              >
                <option value="">(Select or auto-detect)</option>
                <option v-for="hw in localModels" :key="hw.id" :value="hw.id">
                  {{ hw.id }} ({{ hw.totalPorts }} ports)
                </option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Serial Number</label>
              <Input
                v-model="form.serial_number"
                placeholder="S/N"
                class="text-xs font-mono"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">MAC Address</label>
              <Input
                v-model="form.mac_address"
                placeholder="e.g. 00:11:22:33:44:55"
                class="text-xs font-mono"
              />
            </div>
          </div>
        </div>

        <!-- Section 3: SSH Polling Credentials -->
        <div class="border-t pt-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <Icon icon="carbon:password" class="w-3.5 h-3.5 text-primary" />
            SSH Credentials (For Periodic Polling)
          </h4>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="text-xs font-semibold block mb-1">Admin User</label>
              <Input
                v-model="form.admin_username"
                placeholder="admin"
                class="text-xs font-mono"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Admin Password</label>
              <Input
                v-model="form.admin_password"
                type="password"
                placeholder="Leave blank to keep"
                class="text-xs"
              />
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1">Enable Password</label>
              <Input
                v-model="form.enable_password"
                type="password"
                placeholder="Leave blank to keep"
                class="text-xs"
              />
            </div>
          </div>
        </div>

        <!-- Section 4: Danger Zone -->
        <div class="border-t pt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Remove this device from the active fleet database</span>
          <Button
            variant="destructive"
            size="sm"
            class="h-7 text-xs px-2.5"
            :disabled="saving || deleting"
            @click="deleteSwitch"
          >
            <Icon icon="lucide:trash-2" class="w-3.5 h-3.5 mr-1" />
            {{ deleting ? 'Deleting...' : 'Delete Switch' }}
          </Button>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="p-4 border-t flex items-center justify-end gap-2 bg-muted/30">
        <Button variant="outline" size="sm" @click="close" :disabled="saving || deleting">
          Cancel
        </Button>
        <Button size="sm" @click="save" :disabled="saving || deleting">
          <Icon
            icon="lucide:check"
            class="w-4 h-4 mr-1.5"
            :class="saving ? 'animate-spin' : ''"
          />
          {{ saving ? 'Saving Changes...' : 'Save Changes' }}
        </Button>
      </div>
    </div>
  </div>
</template>
