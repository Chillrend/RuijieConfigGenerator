import assert from 'assert';
import { initDatabase, getDB } from './lib/db.js';
import {
  generatePortDeltaCommands,
  parseRunningConfig,
  parsePoeInterfacesStatus,
  parseTransceiverManuinfo,
  parseTransceiverDDM
} from './lib/ruijie-parser.js';

async function runTests() {
  console.log('--- Testing Database & Fleet API Data ---');
  await initDatabase();
  const db = getDB();

  // Test hardware templates including RG-S6250-48XS8CQ
  const s6250 = await db.get('SELECT * FROM hardware_templates WHERE id = ?', ['RG-S6250-48XS8CQ']);
  assert.ok(s6250, 'RG-S6250-48XS8CQ must be present in hardware_templates');
  assert.strictEqual(s6250.totalPorts, 48);
  console.log('✓ RG-S6250-48XS8CQ hardware template present and verified!');

  // Test switches table population
  const switches = await db.all('SELECT * FROM switches');
  console.log(`Found ${switches.length} switches in fleet table`);
  assert.ok(switches.length > 0, 'Switches table should have records imported from deployments');

  // Test single switch structure
  const sw1 = switches[0];
  console.log(`Sample Switch 1: ${sw1.hostname} (${sw1.mgmt_ip})`);
  assert.ok(sw1.mgmt_ip, 'Switch must have management IP');
  assert.ok(sw1.admin_username, 'Switch must have admin username');

  // Test PoE Interface Status Parser
  console.log('\n--- Testing PoE Interface Status Parser ---');
  const samplePoe = `
Interface Power   Power  Curr  Avg   Peak  Curr    Trouble           PD       Port    
          Control Status Power Power Power Current Cause             Class    Voltage 
----------------------------------------------------------------------------------------
MT0/1     enable  off    0.0W  0.0W  0.0W  0mA     Normal            N/A      0.0V    
MT0/3     disable off    0.0W  0.0W  0.0W  0mA     Normal            N/A      0.0V    
MT0/19    enable  on     7.6W  7.0W  13.3W 137mA   Normal            4        55.8V   
  `;
  const parsedPoe = parsePoeInterfacesStatus(samplePoe);
  assert.strictEqual(parsedPoe.length, 3);
  assert.strictEqual(parsedPoe[1].powerControl, 'disable');
  assert.strictEqual(parsedPoe[2].powerStatus, 'on');
  assert.strictEqual(parsedPoe[2].watt, 7.6);
  assert.strictEqual(parsedPoe[2].pdClass, '4');
  console.log('✓ PoE interface parser successfully extracted power status and wattage!');

  // Test Transceiver Manuinfo & DDM Parser
  console.log('\n--- Testing Transceiver Manuinfo & DDM ---');
  const sampleManu = `
========Interface TenGigabitEthernet 0/25========
Vendor Name          : MIKROBITS       
Vendor Part Number   : SFP-10G-SR-MM   
Vendor Serial Number : M21100050164    
  `;
  const sampleTrans = `
========Interface TenGigabitEthernet 0/25========
Transceiver Type    :  10GBASE-SR-SFP+
Wavelength(nm)      :  850
Current diagnostic parameters[AP:Average Power]:
Temp(Celsius)   Voltage(V)      Bias(mA)            RX power(dBm)               TX power(dBm)
34(OK)          3.22(OK)        6.50(OK)            -10.11(OK)[AP]              -1.48(OK)
  `;
  const manuMap = parseTransceiverManuinfo(sampleManu);
  const parsedDdm = parseTransceiverDDM(sampleTrans, manuMap);
  assert.strictEqual(parsedDdm.length, 1);
  assert.strictEqual(parsedDdm[0].vendor, 'MIKROBITS');
  assert.strictEqual(parsedDdm[0].partNumber, 'SFP-10G-SR-MM');
  assert.strictEqual(parsedDdm[0].transceiverType, '10GBASE-SR-SFP+');
  assert.strictEqual(parsedDdm[0].rxPower, -10.11);
  console.log('✓ Transceiver brand and specs merged cleanly with DDM metrics!');

  // Test Non-destructive targeted Delta Command generation
  console.log('\n--- Testing Targeted Non-Destructive Delta CLI ---');
  const existingPort = {
    name: 'GigabitEthernet 0/5',
    mode: 'access',
    vlan: '10',
    description: 'Existing-AP',
    poeMode: 'enabled',
    unmanaged_lines: ['spanning-tree portfast', 'storm-control broadcast level 10']
  };

  const desiredChange = {
    vlan: '20',
    description: 'Updated-AP-Floor2'
  };

  const deltaCmds = generatePortDeltaCommands(existingPort.name, existingPort, desiredChange);
  console.log('Generated Delta Commands:', deltaCmds);

  // Must only touch description and vlan, NOT spanning-tree or storm-control
  assert.deepStrictEqual(deltaCmds, [
    'configure terminal',
    'interface GigabitEthernet 0/5',
    ' description Updated-AP-Floor2',
    ' switchport access vlan 20',
    'end',
    'write'
  ]);
  console.log('✓ Delta generator strictly isolates changed attributes!');

  // Test running config parser preservation
  const rawRunning = `
interface GigabitEthernet 0/5
 description Old-AP
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
 ip dhcp snooping trust
!
  `;
  const parsed = parseRunningConfig(rawRunning);
  assert.deepStrictEqual(parsed.interfaces['GigabitEthernet 0/5'].unmanaged_lines, [
    'spanning-tree portfast',
    'ip dhcp snooping trust'
  ]);
  console.log('✓ Unsupported features captured in unmanaged_lines without loss!');

  // Test Switch Profile Update in DB
  console.log('\n--- Testing Switch Profile Update ---');
  const originalSw = await db.get('SELECT * FROM switches WHERE id = ?', [sw1.id]);
  const testTag = 'TEST-TAG-' + Date.now();
  await db.run(
    `UPDATE switches SET
      hostname = ?, mgmt_ip = ?, admin_username = ?, admin_password = ?,
      enable_password = ?, inventory_tag = ?, model_id = ?, serial_number = ?,
      mac_address = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [originalSw.hostname, originalSw.mgmt_ip, originalSw.admin_username, originalSw.admin_password,
     originalSw.enable_password, testTag, 'RG-S6250-48XS8CQ', 'SNTEST123', '00:11:22:33:44:55', originalSw.id]
  );
  const updated = await db.get('SELECT * FROM switches WHERE id = ?', [sw1.id]);
  assert.strictEqual(updated.inventory_tag, testTag);
  assert.strictEqual(updated.model_id, 'RG-S6250-48XS8CQ');
  assert.strictEqual(updated.serial_number, 'SNTEST123');
  assert.strictEqual(updated.mac_address, '00:11:22:33:44:55');

  // Revert back to original
  await db.run(
    `UPDATE switches SET
      inventory_tag = ?, model_id = ?, serial_number = ?, mac_address = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [originalSw.inventory_tag, originalSw.model_id, originalSw.serial_number, originalSw.mac_address, originalSw.id]
  );
  console.log('✓ Switch profile updates and preserves metadata correctly!');

  console.log('\nAll fleet integration tests completed successfully!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
