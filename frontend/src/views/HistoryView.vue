<script setup>
import { ref, onMounted, nextTick } from 'vue'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const deployments = ref([])
const hardwareOptions = ref([])
const loading = ref(true)

const selectedDeployment = ref(null)
const showModal = ref(false)

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
              <TableCell class="text-right">
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" @click="viewDeployment(dep.id)">View</Button>
                  <Button variant="destructive" size="sm" @click="deleteDeployment(dep.id, dep.hostname)">Delete</Button>
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-if="deployments.length === 0">
              <TableCell colspan="7" class="text-center py-10 text-muted-foreground">No deployments found.</TableCell>
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

            <TabsContent value="cli" class="p-6 m-0 outline-none">
              <textarea class="w-full bg-slate-950 text-emerald-400 font-mono text-sm p-4 rounded-md border min-h-[400px]" readonly :value="selectedDeployment.generated_cli"></textarea>
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
  </main>
</template>
