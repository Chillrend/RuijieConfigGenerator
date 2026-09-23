<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import JsBarcode from 'jsbarcode'
import bwipjs from 'bwip-js'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import LabelPrinterModal from '@/components/LabelPrinterModal.vue'

const router = useRouter()

const deployments = ref([])
const hardwareOptions = ref([])
const loading = ref(true)

const selectedDeployment = ref(null)
const showModal = ref(false)
const showPrintLabelModal = ref(false)

const showEditModal = ref(false)
const editForm = ref({
  id: null,
  hostname: '',
  serial_number: '',
  mac_address: '',
  mgmt_ip: '',
  inventory_tag: '',
})
const editError = ref('')
const editLoading = ref(false)
const savingCli = ref(false)

const barcodeSn = ref(null)
const barcodeMac = ref(null)
const barcodeInventory = ref(null)

async function fetchSetup() {
  try {
    const res = await fetch('/api/setup')
    const data = await res.json()
    hardwareOptions.value = data.hardware || []
  } catch (err) {
    console.error('Failed to fetch setup', err)
  }
}

async function fetchDeployments() {
  loading.value = true
  try {
    const res = await fetch('/api/deployments')
    deployments.value = await res.json()
  } catch (err) {
    console.error('Failed to fetch deployments', err)
  } finally {
    loading.value = false
  }
}

function getPortName(port, modelId) {
  const model = hardwareOptions.value.find(hw => hw.id === modelId)
  if (!model) return `Port ${port.id}`
  const isUplink = model.uplinkPorts.includes(port.id)
  const prefix = isUplink ? model.uplinkPrefix : model.portPrefix
  return `${prefix}${port.id}`
}

async function viewDeployment(id) {
  try {
    const res = await fetch(`/api/deployments/${id}`)
    const data = await res.json()
    data.parsedPayload = JSON.parse(data.config_payload)
    selectedDeployment.value = data
    showModal.value = true
  } catch (err) {
    console.error('Failed to fetch deployment details', err)
  }
}

function close() {
  showModal.value = false
  selectedDeployment.value = null
}

function printDocument() {
  const originalTitle = document.title
  if (selectedDeployment.value?.hostname) {
    document.title = selectedDeployment.value.hostname
  }

  nextTick(() => {
    if (barcodeSn.value && selectedDeployment.value?.serial_number) {
      JsBarcode(barcodeSn.value, selectedDeployment.value.serial_number, { format: 'CODE128', height: 35, displayValue: true, fontSize: 12, margin: 0 })
    }
    if (barcodeMac.value && selectedDeployment.value?.mac_address) {
      JsBarcode(barcodeMac.value, selectedDeployment.value.mac_address, { format: 'CODE128', height: 35, displayValue: true, fontSize: 12, margin: 0 })
    }
    if (barcodeInventory.value && selectedDeployment.value?.inventory_tag) {
      try {
        bwipjs.toCanvas(barcodeInventory.value, {
            bcid: 'datamatrix',
            text: selectedDeployment.value.inventory_tag,
            scale: 3,
            height: 10,
            includetext: false,
        });
      } catch(e) {}
    }
    setTimeout(() => {
      window.print()
      document.title = originalTitle
    }, 100)
  })
}

async function deleteDeployment(id, hostname) {
  if (!confirm(`Are you sure you want to delete the deployment record for ${hostname}? This cannot be undone.`)) {
    return
  }
  try {
    const res = await fetch(`/api/deployments/${id}`, { method: 'DELETE' })
    if (res.ok) {
      deployments.value = deployments.value.filter(d => d.id !== id)
    } else {
      alert('Failed to delete deployment.')
    }
  } catch(err) {
    console.error('Delete error', err)
    alert('Error connecting to server.')
  }
}

function openEditModal(dep) {
  editForm.value = {
    id: dep.id,
    hostname: dep.hostname || '',
    serial_number: dep.serial_number || '',
    mac_address: dep.mac_address || '',
    mgmt_ip: dep.mgmt_ip || '',
    inventory_tag: dep.inventory_tag || '',
  }
  editError.value = ''
  showEditModal.value = true
}

function closeEditModal() {
  showEditModal.value = false
  editError.value = ''
}

function reconfigureDeployment(id) {
  router.push({ path: '/', query: { edit: id } })
}

async function saveRawCli() {
  if (!selectedDeployment.value) return
  savingCli.value = true
  try {
    const res = await fetch(`/api/deployments/${selectedDeployment.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generated_cli: selectedDeployment.value.generated_cli,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'Failed to save CLI changes')
      return
    }
    alert('CLI changes saved successfully!')
    await fetchDeployments()
  } catch (err) {
    alert('Error saving CLI: ' + err.message)
  } finally {
    savingCli.value = false
  }
}

async function saveDeploymentEdit() {
  if (!editForm.value.hostname.trim()) {
    editError.value = 'Hostname is required'
    return
  }
  if (!editForm.value.serial_number.trim()) {
    editError.value = 'Serial Number is required'
    return
  }

  editLoading.value = true
  editError.value = ''

  try {
    const res = await fetch(`/api/deployments/${editForm.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: editForm.value.hostname.trim(),
        serial_number: editForm.value.serial_number.trim(),
        mac_address: editForm.value.mac_address.trim() || null,
        mgmt_ip: editForm.value.mgmt_ip.trim() || null,
        inventory_tag: editForm.value.inventory_tag.trim() || null,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      editError.value = data.error || 'Failed to update deployment'
      return
    }

    await fetchDeployments()

    if (selectedDeployment.value && selectedDeployment.value.id === editForm.value.id) {
      data.parsedPayload = JSON.parse(data.config_payload || '{}')
      selectedDeployment.value = data
    }

    showEditModal.value = false
  } catch (err) {
    editError.value = err.message || 'Error updating deployment'
  } finally {
    editLoading.value = false
  }
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString()
}

function exportCSV() {
  window.location.href = '/api/deployments/export/csv'
}

onMounted(() => {
  fetchSetup().then(fetchDeployments)
})
</script>

<template>
  <main class="max-w-[1200px] mx-auto px-5 space-y-6">
    <Card class="print:hidden">
      <CardHeader class="flex flex-row items-center justify-between">
        <div class="space-y-1.5">
          <CardTitle>Deployment History</CardTitle>
          <CardDescription>View and reprint past switch configurations.</CardDescription>
        </div>
        <Button variant="outline" @click="exportCSV">Export CSV</Button>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="text-center py-10 text-muted-foreground">Loading...</div>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>S/N</TableHead>
              <TableHead>MAC</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Inv Tag</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="dep in deployments" :key="dep.id">
              <TableCell>{{ formatDate(dep.created_at) }}</TableCell>
              <TableCell class="font-medium">{{ dep.hostname }}</TableCell>
              <TableCell>{{ dep.model_id }}</TableCell>
              <TableCell class="font-mono text-xs">{{ dep.serial_number }}</TableCell>
              <TableCell class="font-mono text-xs text-muted-foreground">{{ dep.mac_address || 'N/A' }}</TableCell>
              <TableCell>{{ dep.mgmt_ip || '-' }}</TableCell>
              <TableCell class="font-mono text-xs">{{ dep.inventory_tag || '-' }}</TableCell>
              <TableCell class="text-right">
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" @click="viewDeployment(dep.id)">View</Button>
                  <Button variant="secondary" size="sm" @click="reconfigureDeployment(dep.id)">🛠️ Reconfigure</Button>
                  <Button variant="outline" size="sm" @click="openEditModal(dep)">Edit Info</Button>
                  <Button variant="destructive" size="sm" @click="deleteDeployment(dep.id, dep.hostname)">Delete</Button>
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-if="deployments.length === 0">
              <TableCell colspan="8" class="text-center py-10 text-muted-foreground">No deployments found.</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <!-- Modal view for selected deployment (hidden on print) -->
    <div v-if="showModal && selectedDeployment" class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
      <Card class="w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl">
        <CardHeader class="flex flex-row items-center justify-between border-b pb-4">
          <div>
            <CardTitle>Deployment: {{ selectedDeployment.hostname }}</CardTitle>
            <CardDescription>{{ formatDate(selectedDeployment.created_at) }}</CardDescription>
          </div>
          <div class="flex gap-2">
            <Button variant="secondary" @click="reconfigureDeployment(selectedDeployment.id)">🛠️ Reconfigure</Button>
            <Button variant="outline" @click="openEditModal(selectedDeployment)">✏️ Edit Info</Button>
            <Button variant="outline" @click="showPrintLabelModal = true">🏷️ Print Label</Button>
            <Button variant="outline" @click="printDocument">🖨️ Print</Button>
            <Button variant="ghost" @click="close">Close</Button>
          </div>
        </CardHeader>
        <CardContent class="flex-1 overflow-y-auto p-0">
          <Tabs defaultValue="details" class="w-full">
            <div class="px-6 pt-4 border-b">
              <TabsList>
                <TabsTrigger value="details">Summary Details</TabsTrigger>
                <TabsTrigger value="cli">Raw CLI</TabsTrigger>
              </TabsList>
            </div>
            
            <TabsContent value="details" class="p-6 m-0 outline-none space-y-6">
              <div class="grid grid-cols-2 gap-6 text-sm">
                <div class="space-y-2">
                  <h3 class="font-bold text-lg border-b pb-1">Identity</h3>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">Hostname:</span> {{ selectedDeployment.hostname }}</div>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">Hardware Model:</span> {{ selectedDeployment.model_id }}</div>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">Serial Number:</span> {{ selectedDeployment.serial_number }}</div>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">MAC Address:</span> {{ selectedDeployment.mac_address || 'N/A' }}</div>
                  <div v-if="selectedDeployment.inventory_tag"><span class="font-semibold text-muted-foreground w-32 inline-block">Inventory Tag:</span> <Badge variant="secondary">{{ selectedDeployment.inventory_tag }}</Badge></div>
                </div>
                
                <div class="space-y-2">
                  <h3 class="font-bold text-lg border-b pb-1">Services & Management</h3>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">SSH Service:</span> {{ selectedDeployment.parsedPayload.enableSsh ? 'Enabled' : 'Disabled' }}</div>
                  <div><span class="font-semibold text-muted-foreground w-32 inline-block">Web Management:</span> {{ selectedDeployment.parsedPayload.enableWeb ? 'Enabled' : 'Disabled' }}</div>
                  <div v-if="selectedDeployment.parsedPayload.timezone"><span class="font-semibold text-muted-foreground w-32 inline-block">Timezone:</span> {{ selectedDeployment.parsedPayload.timezone }}</div>
                  <div v-if="selectedDeployment.parsedPayload.ntpServers"><span class="font-semibold text-muted-foreground w-32 inline-block">NTP Servers:</span> {{ Array.isArray(selectedDeployment.parsedPayload.ntpServers) ? selectedDeployment.parsedPayload.ntpServers.join(', ') : selectedDeployment.parsedPayload.ntpServers }}</div>
                  <div v-if="selectedDeployment.mgmt_ip"><span class="font-semibold text-muted-foreground w-32 inline-block">Management IP:</span> {{ selectedDeployment.mgmt_ip }} (VLAN {{ selectedDeployment.parsedPayload.mgmtVlan }})</div>
                </div>
              </div>

              <div>
                <h3 class="font-bold text-lg border-b pb-1 mb-3">VLAN Database</h3>
                <div class="flex flex-wrap gap-2">
                  <Badge v-for="vlan in selectedDeployment.parsedPayload.vlans" :key="vlan.id" variant="outline">
                    <span class="mr-1 text-primary">{{ vlan.id }}</span> {{ vlan.name }}
                  </Badge>
                </div>
              </div>

              <div>
                <h3 class="font-bold text-lg border-b pb-1 mb-3">Port Configurations</h3>
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
                    <TableRow v-for="port in selectedDeployment.parsedPayload.ports.filter(p => p.configured)" :key="port.id">
                      <TableCell class="font-mono text-xs">{{ getPortName(port, selectedDeployment.model_id) }}</TableCell>
                      <TableCell>{{ port.description || '-' }}</TableCell>
                      <TableCell><Badge :variant="port.mode === 'access' ? 'default' : 'secondary'">{{ port.mode }}</Badge></TableCell>
                      <TableCell>{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="cli" class="p-6 m-0 outline-none space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">You can edit the raw CLI below and save changes directly to this deployment.</span>
                <Button size="sm" @click="saveRawCli" :disabled="savingCli">
                  {{ savingCli ? 'Saving...' : '💾 Save CLI Changes' }}
                </Button>
              </div>
              <textarea v-model="selectedDeployment.generated_cli" class="w-full bg-slate-950 text-emerald-400 font-mono text-sm p-4 rounded-md border min-h-[400px]"></textarea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>

    <!-- ═══ Print Only Summary (Only rendered if selectedDeployment is active and we are printing) ═══ -->
    <div v-if="selectedDeployment" class="hidden print:block space-y-6 text-black bg-white min-h-screen p-8">
      <div class="border-b pb-6">
        <h2 class="text-3xl font-bold mb-4 border-b pb-2">Switch {{ selectedDeployment.hostname || 'Unknown' }} Provisioning Summary</h2>
        <div class="grid grid-cols-2 gap-6 text-sm">
          <div class="space-y-2">
            <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Identity</h3>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">Hostname:</span> {{ selectedDeployment.hostname }}</div>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">Hardware Model:</span> {{ selectedDeployment.model_id }}</div>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">Serial Number:</span> {{ selectedDeployment.serial_number }}</div>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">MAC Address:</span> {{ selectedDeployment.mac_address || 'N/A' }}</div>
          </div>
          
          <div class="space-y-2">
            <h3 class="font-bold text-lg text-slate-700 border-b pb-1">Services & Management</h3>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">SSH Service:</span> {{ selectedDeployment.parsedPayload.enableSsh ? 'Enabled' : 'Disabled' }}</div>
            <div><span class="font-semibold text-slate-500 w-32 inline-block">Web Management:</span> {{ selectedDeployment.parsedPayload.enableWeb ? 'Enabled' : 'Disabled' }}</div>
            <div v-if="selectedDeployment.parsedPayload.timezone"><span class="font-semibold text-slate-500 w-32 inline-block">Timezone:</span> {{ selectedDeployment.parsedPayload.timezone }}</div>
            <div v-if="selectedDeployment.parsedPayload.ntpServers"><span class="font-semibold text-slate-500 w-32 inline-block">NTP Servers:</span> {{ Array.isArray(selectedDeployment.parsedPayload.ntpServers) ? selectedDeployment.parsedPayload.ntpServers.join(', ') : selectedDeployment.parsedPayload.ntpServers }}</div>
            <div v-if="selectedDeployment.mgmt_ip"><span class="font-semibold text-slate-500 w-32 inline-block">Management IP:</span> {{ selectedDeployment.mgmt_ip }} (VLAN {{ selectedDeployment.parsedPayload.mgmtVlan }})</div>
            
            <div v-if="selectedDeployment.inventory_tag" class="mt-4 border p-2 rounded-md inline-flex items-center gap-4 bg-slate-50">
              <canvas ref="barcodeInventory"></canvas>
              <div>
                <div class="text-[10px] text-slate-500 font-semibold uppercase">Inventory Tag</div>
                <div class="font-mono font-bold">{{ selectedDeployment.inventory_tag }}</div>
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
          <div v-if="selectedDeployment.mac_address" class="border p-2 rounded-md bg-slate-50 text-center inline-block min-w-[280px]">
            <div class="text-[10px] text-slate-500 mb-1 font-semibold uppercase">MAC Address</div>
            <svg ref="barcodeMac" class="w-full h-[50px] mx-auto"></svg>
          </div>
          <div v-else class="border p-2 rounded-md bg-slate-50 flex items-center justify-center min-w-[280px]">
            <div class="text-slate-400 italic">No MAC Address Provided</div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-xl font-bold mb-3 text-slate-800 mt-6">VLAN Database</h3>
        <div class="flex flex-wrap gap-2">
          <span v-for="vlan in selectedDeployment.parsedPayload.vlans" :key="vlan.id" class="border border-slate-300 rounded px-2 py-1 text-sm bg-slate-50">
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
            <tr v-for="port in selectedDeployment.parsedPayload.ports.filter(p => p.configured && !p.isUplink)" :key="port.id">
              <td class="border border-slate-300 p-2 font-mono text-xs">{{ getPortName(port, selectedDeployment.model_id) }}</td>
              <td class="border border-slate-300 p-2">{{ port.description || '-' }}</td>
              <td class="border border-slate-300 p-2"><span class="uppercase text-[10px] tracking-wider font-bold text-slate-500">{{ port.mode }}</span></td>
              <td class="border border-slate-300 p-2">{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</td>
            </tr>
            <tr v-if="selectedDeployment.parsedPayload.ports.filter(p => p.configured && !p.isUplink).length === 0">
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
            <tr v-for="port in selectedDeployment.parsedPayload.ports.filter(p => p.configured && p.isUplink)" :key="port.id">
              <td class="border border-slate-300 p-2 font-mono text-xs">{{ getPortName(port, selectedDeployment.model_id) }}</td>
              <td class="border border-slate-300 p-2">{{ port.description || '-' }}</td>
              <td class="border border-slate-300 p-2"><span class="uppercase text-[10px] tracking-wider font-bold text-slate-500">{{ port.mode }}</span></td>
              <td class="border border-slate-300 p-2">{{ port.mode === 'access' ? port.vlan : port.allowed_vlans }}</td>
            </tr>
            <tr v-if="selectedDeployment.parsedPayload.ports.filter(p => p.configured && p.isUplink).length === 0">
              <td colspan="4" class="border border-slate-300 p-6 text-center italic text-slate-500">
                No uplink ports configured.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Edit Deployment Modal -->
    <div v-if="showEditModal" class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
      <Card class="w-full max-w-lg shadow-xl">
        <CardHeader class="border-b pb-4">
          <CardTitle>Edit Deployment Record</CardTitle>
          <CardDescription>Update identity or inventory information for this switch.</CardDescription>
        </CardHeader>
        <CardContent class="p-6 space-y-4">
          <div v-if="editError" class="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
            {{ editError }}
          </div>

          <div class="space-y-1.5">
            <Label for="edit-hostname">Hostname</Label>
            <Input id="edit-hostname" v-model="editForm.hostname" placeholder="e.g. CORE-SW-01" />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="edit-sn">Serial Number</Label>
              <Input id="edit-sn" v-model="editForm.serial_number" placeholder="S/N" />
            </div>
            <div class="space-y-1.5">
              <Label for="edit-mac">MAC Address</Label>
              <Input id="edit-mac" v-model="editForm.mac_address" placeholder="e.g. 00:11:22:33:44:55" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="edit-ip">Management IP</Label>
              <Input id="edit-ip" v-model="editForm.mgmt_ip" placeholder="e.g. 10.90.0.10" />
            </div>
            <div class="space-y-1.5">
              <Label for="edit-tag">Inventory Tag</Label>
              <Input id="edit-tag" v-model="editForm.inventory_tag" placeholder="e.g. INV-12345678" />
            </div>
          </div>

          <div class="pt-2">
            <Button variant="secondary" size="sm" class="w-full text-xs font-medium" @click="reconfigureDeployment(editForm.id)">
              🛠️ Open in Full Provisioner (Edit Ports & VLANs)
            </Button>
          </div>

          <div class="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" @click="closeEditModal" :disabled="editLoading">Cancel</Button>
            <Button @click="saveDeploymentEdit" :disabled="editLoading">
              {{ editLoading ? 'Saving...' : 'Save Changes' }}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
    
    <LabelPrinterModal
      v-model:open="showPrintLabelModal"
      :hostname="selectedDeployment?.hostname"
      :inventoryTag="selectedDeployment?.inventoryTag || selectedDeployment?.inventory_tag"
      :managementIp="selectedDeployment?.mgmtIp || selectedDeployment?.mgmt_ip"
      :serialNumber="selectedDeployment?.serialNumber || selectedDeployment?.serial_number"
      :macAddress="selectedDeployment?.macAddress || selectedDeployment?.mac_address"
    />
  </main>
</template>
