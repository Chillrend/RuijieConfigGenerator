import assert from 'assert';
import {
  parseRunningConfig,
  generatePortDeltaCommands,
  parseInterfacesStatus,
  parseTransceiverDDM,
  parseLLDPNeighbors,
  parseShowVersion,
  normalizePortName
} from './ruijie-parser.js';

console.log('Testing Ruijie Parser...');

// 1. Test running config parsing with custom / unsupported lines
const sampleRunningConfig = `
!
hostname SW-Floor2-Edge
!
vlan 10
 name Users
!
vlan 20
 name Servers
!
interface GigabitEthernet 0/1
 description Workstation-01
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
 storm-control broadcast level 20.0
!
interface TenGigabitEthernet 0/13
 description UPLINK-TO-CORE
 switchport mode trunk
 switchport trunk allowed vlan 10,20,90
 switchport trunk native vlan 90
 ip dhcp snooping trust
!
end
`;

const parsed = parseRunningConfig(sampleRunningConfig);
assert.strictEqual(parsed.hostname, 'SW-Floor2-Edge');
assert.strictEqual(parsed.vlans.length, 2);
assert.ok(parsed.interfaces['GigabitEthernet 0/1']);
assert.strictEqual(parsed.interfaces['GigabitEthernet 0/1'].vlan, '10');
// Verify unsupported lines are preserved!
assert.deepStrictEqual(parsed.interfaces['GigabitEthernet 0/1'].unmanaged_lines, [
  'spanning-tree portfast',
  'storm-control broadcast level 20.0'
]);
assert.deepStrictEqual(parsed.interfaces['TenGigabitEthernet 0/13'].unmanaged_lines, [
  'ip dhcp snooping trust'
]);
console.log('✓ parseRunningConfig correctly preserves unsupported/custom lines');

// 2. Test generatePortDeltaCommands
const currentPort = parsed.interfaces['GigabitEthernet 0/1'];
const deltaCommands = generatePortDeltaCommands('GigabitEthernet 0/1', currentPort, {
  vlan: '20',
  description: 'Workstation-01-VIP'
});

assert.deepStrictEqual(deltaCommands, [
  'configure terminal',
  'interface GigabitEthernet 0/1',
  ' description Workstation-01-VIP',
  ' switchport access vlan 20',
  'end',
  'write'
]);
console.log('✓ generatePortDeltaCommands produces minimal targeted delta');

// 3. Test parseInterfacesStatus
const sampleStatus = `
Interface         Status    Vlan      Duplex   Speed    Type
----------------- --------- --------- -------- -------- --------------------
Gi0/1             Connected 10        Full     1000M    1000-Base-T
Gi0/2             NotConnect 10        Auto     Auto     1000-Base-T
Te0/13            Connected Trunk     Full     10G      10G-Base-SR
`;
const portStatuses = parseInterfacesStatus(sampleStatus);
assert.strictEqual(portStatuses.length, 3);
assert.strictEqual(portStatuses[0].status, 'up');
assert.strictEqual(portStatuses[0].port, 'GigabitEthernet 0/1');
assert.strictEqual(portStatuses[1].status, 'down');
assert.strictEqual(portStatuses[2].status, 'up');
assert.strictEqual(portStatuses[2].port, 'TenGigabitEthernet 0/13');
console.log('✓ parseInterfacesStatus correctly parses interface status');

// 4. Test parseTransceiverDDM
const sampleDDM = `
Interface          Temp(C)  Voltage(V)  Bias(mA)  Tx Power(dBm)  Rx Power(dBm)
------------------ -------- ----------- --------- -------------- --------------
Te0/13             32.5     3.31        15.20     -2.15          -3.40
Te0/14             30.1     3.29        14.80     -2.20          -21.50
`;
const ddmResults = parseTransceiverDDM(sampleDDM);
assert.strictEqual(ddmResults.length, 2);
assert.strictEqual(ddmResults[0].port, 'TenGigabitEthernet 0/13');
assert.strictEqual(ddmResults[0].rxPower, -3.40);
assert.strictEqual(ddmResults[0].status, 'normal');
assert.strictEqual(ddmResults[1].status, 'critical'); // -21.50 dBm is < -20
console.log('✓ parseTransceiverDDM tabular parsing verified');

// 5. Test parseLLDPNeighbors (Uplink detection)
const sampleLLDP = `
Capability codes: (R) Router, (B) Bridge, (W) WLAN AP, (C) DOCSIS Cable Device, (O) Other
Device ID            Local Intf          Hold-time Capability  Port ID
SW-Core-Perpus       Te0/13              120       B,R         Te0/1
AP-GPUT-01           Gi0/1               120       W           eth0
`;
const lldpNeighbors = parseLLDPNeighbors(sampleLLDP);
assert.strictEqual(lldpNeighbors.length, 2);
assert.strictEqual(lldpNeighbors[0].isUplink, true);
assert.strictEqual(lldpNeighbors[0].remoteDevice, 'SW-Core-Perpus');
assert.strictEqual(lldpNeighbors[0].localPort, 'TenGigabitEthernet 0/13');
assert.strictEqual(lldpNeighbors[1].isUplink, false);
console.log('✓ parseLLDPNeighbors detects Uplinks accurately via remote switch capability');

// 6. Test parseShowVersion
const sampleVersion = `
Ruijie OS Software, Version RGOS 11.4(1)B75P2
System uptime is 42 weeks, 3 days, 14 hours, 22 minutes
Device model: RG-S5350-24GT4XS-P-E
Device serial number: G1UDBQ3019755
System MAC Address: d833.2afe.3687
`;
const ver = parseShowVersion(sampleVersion);
assert.strictEqual(ver.model, 'RG-S5350-24GT4XS-P-E');
assert.strictEqual(ver.serial, 'G1UDBQ3019755');
assert.ok(ver.uptime.includes('42 weeks'));
console.log('✓ parseShowVersion extracts switch metadata');

console.log('\nAll Ruijie parser tests passed successfully!');
