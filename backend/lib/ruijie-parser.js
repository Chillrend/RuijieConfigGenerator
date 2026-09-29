// ponytail: regex-based CLI parsing for Ruijie RGOS; minimal, no heavyweight AST parser needed

/**
 * Normalizes interface names like "MTGigabitEthernet 0/1", "GigabitEthernet 0/1", "TenGigabitEthernet 0/13"
 */
export function normalizePortName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  return trimmed
    .replace(/^MT(?:GigabitEthernet)?\s*/i, 'MTGigabitEthernet ')
    .replace(/^Gi(?:gabitEthernet)?\s*/i, 'GigabitEthernet ')
    .replace(/^Te(?:nGigabitEthernet)?\s*/i, 'TenGigabitEthernet ')
    .replace(/^TF(?:GigabitEthernet)?\s*/i, 'TFGigabitEthernet ')
    .replace(/^TwentyFive(?:GigE|GigabitEthernet)?\s*/i, 'TwentyFiveGigE ')
    .replace(/^25G\s*/i, 'TwentyFiveGigE ')
    .replace(/^Forty(?:GigabitEthernet)?\s*/i, 'FortyGigabitEthernet ')
    .replace(/^Fo\s*/i, 'FortyGigabitEthernet ')
    .replace(/^(?:HundredGigabitEthernet|HundredGigE|Hu)\s*/i, 'HundredGigabitEthernet ')
    .replace(/^FastEthernet\s*/i, 'FastEthernet ')
    .replace(/^Fa\s*/i, 'FastEthernet ')
    .replace(/^Ag(?:gregatePort)?\s*/i, 'AggregatePort ');
}

export function shortPortName(name) {
  if (!name) return '';
  return name.trim()
    .replace(/^MTGigabitEthernet\s*/i, 'MTGi')
    .replace(/^GigabitEthernet\s*/i, 'Gi')
    .replace(/^TenGigabitEthernet\s*/i, 'Te')
    .replace(/^TFGigabitEthernet\s*/i, 'TF')
    .replace(/^TwentyFive(?:GigE|GigabitEthernet)\s*/i, '25G')
    .replace(/^FortyGigabitEthernet\s*/i, 'Fo')
    .replace(/^(?:HundredGigabitEthernet|HundredGigE)\s*/i, 'Hu')
    .replace(/^AggregatePort\s*/i, 'Ag');
}

/**
 * Isolate output between command issue and prompt
 */
export function extractCommandOutput(fullOutput, command) {
  if (!fullOutput || typeof fullOutput !== 'string') return '';
  const esc = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:#\\s*${esc}\\s*\\r?\\n)([\\s\\S]*?)(?:\\r?\\n[\\w\\-\\.]+#|$)`, 'i');
  const match = fullOutput.match(regex);
  return match ? match[1].trim() : fullOutput;
}

/**
 * Parse `show running-config` into structured interface blocks while capturing unmanaged lines
 */
export function parseRunningConfig(rawCli) {
  if (!rawCli || typeof rawCli !== 'string') {
    return { hostname: '', vlans: [], interfaces: {}, globalUnmanaged: [] };
  }

  const lines = rawCli.split(/\r?\n/);
  const result = {
    hostname: '',
    vlans: [],
    interfaces: {},
    globalUnmanaged: []
  };

  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed === '!' || trimmed === 'end' || trimmed.startsWith('Building configuration') || trimmed.startsWith('Current configuration')) {
      if (currentBlock) {
        finishBlock(currentBlock, result);
        currentBlock = null;
      }
      continue;
    }

    // Hostname
    const hostMatch = trimmed.match(/^hostname\s+(\S+)/i);
    if (hostMatch) {
      result.hostname = hostMatch[1];
      continue;
    }

    // VLAN block: vlan 10
    const vlanMatch = trimmed.match(/^vlan\s+(\d+)/i);
    if (vlanMatch && !line.startsWith(' ')) {
      if (currentBlock) finishBlock(currentBlock, result);
      currentBlock = { type: 'vlan', id: parseInt(vlanMatch[1], 10), name: '', lines: [] };
      continue;
    }

    // Interface block: interface MTGigabitEthernet 0/1 or GigabitEthernet 0/1 or TenGigabitEthernet 0/25 or HundredGigabitEthernet 0/49
    const intMatch = trimmed.match(/^interface\s+((?:MTGigabitEthernet|GigabitEthernet|TenGigabitEthernet|TFGigabitEthernet|TwentyFiveGigE|TwentyFiveGigabitEthernet|FortyGigabitEthernet|HundredGigabitEthernet|HundredGigE|Hu|FastEthernet|AggregatePort|VLAN)\s*[0-9\/\-\.]+)/i);
    if (intMatch && !line.startsWith(' ')) {
      if (currentBlock) finishBlock(currentBlock, result);
      const fullName = normalizePortName(intMatch[1]);
      currentBlock = {
        type: 'interface',
        name: fullName,
        description: '',
        mode: 'access',
        vlan: '1',
        allowed_vlans: 'all',
        native_vlan: '',
        poeMode: 'default',
        poePriority: 'default',
        poeMaxPower: '',
        aggregatePort: null,
        aggregateGroupId: null,
        shutdown: false,
        unmanaged_lines: []
      };
      continue;
    }

    // Inside current block
    if (currentBlock) {
      if (currentBlock.type === 'vlan') {
        const nameMatch = trimmed.match(/^name\s+(.+)$/i);
        if (nameMatch) {
          currentBlock.name = nameMatch[1];
        } else {
          currentBlock.lines.push(trimmed);
        }
      } else if (currentBlock.type === 'interface') {
        if (/^shutdown$/i.test(trimmed)) {
          currentBlock.shutdown = true;
        } else if (/^no\s+shutdown$/i.test(trimmed)) {
          currentBlock.shutdown = false;
        } else if (/^description\s+/i.test(trimmed)) {
          currentBlock.description = trimmed.replace(/^description\s+/i, '');
        } else if (/^switchport\s+mode\s+(\w+)/i.test(trimmed)) {
          currentBlock.mode = trimmed.match(/^switchport\s+mode\s+(\w+)/i)[1].toLowerCase();
        } else if (/^switchport\s+access\s+vlan\s+(\d+)/i.test(trimmed)) {
          currentBlock.vlan = trimmed.match(/^switchport\s+access\s+vlan\s+(\d+)/i)[1];
        } else if (/^switchport\s+trunk\s+allowed\s+vlan\s+(.+)/i.test(trimmed)) {
          currentBlock.allowed_vlans = trimmed.match(/^switchport\s+trunk\s+allowed\s+vlan\s+(.+)/i)[1];
        } else if (/^switchport\s+trunk\s+native\s+vlan\s+(\d+)/i.test(trimmed)) {
          currentBlock.native_vlan = trimmed.match(/^switchport\s+trunk\s+native\s+vlan\s+(\d+)/i)[1];
        } else if (/^no\s+poe\s+enable$/i.test(trimmed)) {
          currentBlock.poeMode = 'disabled';
        } else if (/^poe\s+enable$/i.test(trimmed)) {
          currentBlock.poeMode = 'enabled';
        } else if (/^poe\s+priority\s+(\w+)/i.test(trimmed)) {
          currentBlock.poePriority = trimmed.match(/^poe\s+priority\s+(\w+)/i)[1];
        } else if (/^poe\s+max-power\s+(\d+)/i.test(trimmed)) {
          currentBlock.poeMaxPower = trimmed.match(/^poe\s+max-power\s+(\d+)/i)[1];
        } else if (/^port-group\s+(\d+)/i.test(trimmed)) {
          const pgNum = trimmed.match(/^port-group\s+(\d+)/i)[1];
          currentBlock.aggregatePort = `Ag${pgNum}`;
          currentBlock.aggregateGroupId = parseInt(pgNum, 10);
          currentBlock.unmanaged_lines.push(trimmed);
        } else {
          currentBlock.unmanaged_lines.push(trimmed);
        }
      }
    } else {
      result.globalUnmanaged.push(trimmed);
    }
  }

  if (currentBlock) {
    finishBlock(currentBlock, result);
  }

  return result;
}

function finishBlock(block, result) {
  if (block.type === 'vlan') {
    result.vlans.push({ id: block.id, name: block.name || `VLAN${block.id}`, lines: block.lines });
  } else if (block.type === 'interface') {
    result.interfaces[block.name] = block;
  }
}

/**
 * Generate targeted CLI deltas for an interface update without modifying unsupported configs.
 */
export function generatePortDeltaCommands(portName, current, desired) {
  const normName = normalizePortName(portName);
  const commands = [];
  const curr = current || {};

  // Description
  if (desired.description !== undefined && desired.description !== curr.description) {
    if (desired.description) {
      commands.push(`description ${desired.description}`);
    } else if (curr.description) {
      commands.push('no description');
    }
  }

  // Switchport mode
  if (desired.mode && desired.mode !== curr.mode) {
    commands.push(`switchport mode ${desired.mode}`);
  }

  const effectiveMode = desired.mode || curr.mode || 'access';

  // Access VLAN
  if (effectiveMode === 'access') {
    if (desired.vlan && String(desired.vlan) !== String(curr.vlan)) {
      commands.push(`switchport access vlan ${desired.vlan}`);
    }
  } else if (effectiveMode === 'trunk') {
    if (desired.allowed_vlans && desired.allowed_vlans !== curr.allowed_vlans) {
      commands.push(`switchport trunk allowed vlan ${desired.allowed_vlans}`);
    }
    if (desired.native_vlan !== undefined && String(desired.native_vlan) !== String(curr.native_vlan || '')) {
      if (desired.native_vlan) {
        commands.push(`switchport trunk native vlan ${desired.native_vlan}`);
      } else if (curr.native_vlan) {
        commands.push('no switchport trunk native vlan');
      }
    }
  }

  // PoE settings
  if (desired.poeMode !== undefined && desired.poeMode !== curr.poeMode) {
    if (desired.poeMode === 'disabled') {
      commands.push('no poe enable');
    } else if (desired.poeMode === 'enabled') {
      commands.push('poe enable');
    }
  }

  if (desired.poePriority && desired.poePriority !== curr.poePriority) {
    if (desired.poePriority === 'default') {
      commands.push('no poe priority');
    } else {
      commands.push(`poe priority ${desired.poePriority}`);
    }
  }

  if (desired.poeMaxPower !== undefined && desired.poeMaxPower !== curr.poeMaxPower) {
    if (desired.poeMaxPower) {
      commands.push(`poe max-power ${desired.poeMaxPower}`);
    } else {
      commands.push('no poe max-power');
    }
  }

  // Admin status
  if (desired.shutdown !== undefined && desired.shutdown !== curr.shutdown) {
    commands.push(desired.shutdown ? 'shutdown' : 'no shutdown');
  }

  if (commands.length === 0) {
    return [];
  }

  return [
    'configure terminal',
    `interface ${normName}`,
    ...commands.map(cmd => ` ${cmd}`),
    'end',
    'write'
  ];
}

/**
 * Parse `show interfaces status`
 */
export function parseInterfacesStatus(output) {
  if (!output || typeof output !== 'string') return [];
  const lines = output.split(/\r?\n/);
  const results = [];

  const PORT_NAME_REGEX = /^(?:MTGigabitEthernet|MTGi|GigabitEthernet|Gi|TenGigabitEthernet|Te|TFGigabitEthernet|TF|TwentyFiveGigabitEthernet|TwentyFiveGigE|25G|FortyGigabitEthernet|Fo|HundredGigabitEthernet|HundredGigE|Hu|FastEthernet|Fa|AggregatePort|Ag)/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Interface') || trimmed.startsWith('---') || trimmed.startsWith('%') || trimmed.startsWith('===')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3 && PORT_NAME_REGEX.test(parts[0])) {
      let portName = parts[0];
      let offset = 0;
      if (parts[1] && /^\d+\/\d+/.test(parts[1])) {
        portName = `${parts[0]} ${parts[1]}`;
        offset = 1;
      }

      const statusRaw = (parts[1 + offset] || '').toLowerCase();
      const status = (statusRaw === 'up' || (statusRaw.includes('connect') && !statusRaw.includes('not'))) ? 'up' :
                     statusRaw.includes('disable') ? 'disabled' : 'down';

      results.push({
        port: normalizePortName(portName),
        portShort: shortPortName(portName),
        status,
        rawStatus: parts[1 + offset] || '',
        vlan: parts[2 + offset] || '',
        duplex: parts[3 + offset] || 'Auto',
        speed: parts[4 + offset] || 'Auto',
        mediaType: parts.slice(5 + offset).join(' ') || ''
      });
    }
  }

  return results;
}

/**
 * Parse `show interfaces transceiver`
 */
/**
 * Parse `show interfaces transceiver manuinfo`
 */
export function parseTransceiverManuinfo(output) {
  if (!output || typeof output !== 'string') return new Map();
  const map = new Map();
  const blocks = output.split(/========Interface\s+/i);
  for (const b of blocks) {
    if (!b.trim()) continue;
    const portMatch = b.match(/^([A-Za-z0-9\s\/]+)========/);
    if (!portMatch) continue;
    const port = normalizePortName(portMatch[1]);
    const short = shortPortName(port);

    const vendorMatch = b.match(/Vendor\s+Name\s*:\s*([^\r\n]+)/i);
    const partMatch = b.match(/Vendor\s+Part\s+Number\s*:\s*([^\r\n]+)/i);
    const snMatch = b.match(/Vendor\s+Serial\s+Number\s*:\s*([^\r\n]+)/i);

    const info = {
      vendor: vendorMatch ? vendorMatch[1].trim() : '',
      partNumber: partMatch ? partMatch[1].trim() : '',
      serialNumber: snMatch ? snMatch[1].trim() : ''
    };
    map.set(port, info);
    map.set(short, info);
  }
  return map;
}

/**
 * Parse `show poe interfaces status`
 */
export function parsePoeInterfacesStatus(output) {
  if (!output || typeof output !== 'string') return [];
  const lines = output.split(/\r?\n/);
  const results = [];
  let pastHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Interface') || trimmed.startsWith('Control')) continue;
    if (trimmed.startsWith('---')) {
      pastHeader = true;
      continue;
    }
    if (!pastHeader) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 4) {
      let portName = parts[0];
      let offset = 0;
      if (parts[1] && /^\d+\/\d+/.test(parts[1])) {
        portName = `${parts[0]} ${parts[1]}`;
        offset = 1;
      }
      const powerControl = (parts[1 + offset] || 'enable').toLowerCase();
      const powerStatus = (parts[2 + offset] || 'off').toLowerCase();
      const currPowerRaw = parts[3 + offset] || '0.0W';
      const watt = parseFloat(currPowerRaw.replace(/[^0-9\.]/g, '')) || 0;
      const pdClass = parts[8 + offset] || 'N/A';
      const voltage = parts[9 + offset] || '';

      const norm = normalizePortName(portName);
      results.push({
        port: norm,
        portShort: shortPortName(norm),
        powerControl,
        powerStatus,
        currPower: currPowerRaw,
        watt,
        pdClass,
        voltage
      });
    }
  }
  return results;
}

/**
 * Parse `show interfaces transceiver`
 */
export function parseTransceiverDDM(output, manuinfo = null) {
  if (!output || typeof output !== 'string') return [];
  const results = [];
  const manuMap = manuinfo instanceof Map ? manuinfo : (typeof manuinfo === 'string' ? parseTransceiverManuinfo(manuinfo) : new Map());

  // Check for Ruijie block format: ========Interface ...========
  if (output.includes('========Interface')) {
    const blocks = output.split(/========Interface\s+/i);
    for (const b of blocks) {
      if (!b.trim()) continue;
      const portMatch = b.match(/^([A-Za-z0-9\s\/]+)========/);
      if (!portMatch) continue;
      const port = normalizePortName(portMatch[1]);
      const short = shortPortName(port);
      const manu = manuMap.get(port) || manuMap.get(short) || {};

      const typeMatch = b.match(/Transceiver\s+Type\s*:\s*([^\r\n]+)/i);
      const waveMatch = b.match(/Wavelength\(nm\)\s*:\s*([^\r\n]+)/i);
      const snMatch = b.match(/Vendor\s+Serial\s+Number\s*:\s*([^\r\n]+)/i);

      const transType = typeMatch ? typeMatch[1].trim() : '';
      const wavelength = waveMatch ? waveMatch[1].trim() : '';
      const serialNumber = manu.serialNumber || (snMatch ? snMatch[1].trim() : '');

      if (b.includes('the transceiver is absent!')) {
        results.push({
          port,
          portShort: short,
          vendor: manu.vendor || '',
          partNumber: manu.partNumber || '',
          transceiverType: transType,
          wavelength,
          serialNumber,
          temperature: null,
          voltage: null,
          biasCurrent: null,
          txPower: null,
          rxPower: null,
          status: 'absent'
        });
        continue;
      }

      const paramMatch = b.match(/Temp\(Celsius\)\s+Voltage\(V\)\s+Bias\(mA\)\s+RX power\(dBm\)\s+TX power\(dBm\)\s*\r?\n\s*([^\r\n]+)/i);
      if (paramMatch) {
        const parts = paramMatch[1].trim().split(/\s+/);
        const temp = parseFloat(parts[0]) || null;
        const volt = parseFloat(parts[1]) || null;
        const bias = parseFloat(parts[2]) || null;
        const rx = parts[3] === 'NA' ? null : parseFloat(parts[3]);
        const tx = parts[4] === 'NA' ? null : parseFloat(parts[4]);

        results.push({
          port,
          portShort: short,
          vendor: manu.vendor || '',
          partNumber: manu.partNumber || '',
          transceiverType: transType,
          wavelength,
          serialNumber,
          temperature: temp,
          voltage: volt,
          biasCurrent: bias,
          rxPower: rx,
          txPower: tx,
          status: rx === null ? 'no_signal' : getOpticalHealth(rx)
        });
      } else {
        // Transceiver is present, but Digital Diagnostic Monitoring (DDM) is not supported
        results.push({
          port,
          portShort: short,
          vendor: manu.vendor || '',
          partNumber: manu.partNumber || '',
          transceiverType: transType,
          wavelength,
          serialNumber,
          temperature: null,
          voltage: null,
          biasCurrent: null,
          rxPower: null,
          txPower: null,
          status: 'no_ddm'
        });
      }
    }
    // Also include any transceivers found in manuinfo that weren't captured in blocks
    const seenPorts = new Set();
    for (const r of results) {
      seenPorts.add(r.port);
      seenPorts.add(r.portShort);
      seenPorts.add(normalizePortName(r.port));
    }
    for (const [mPort, mInfo] of manuMap.entries()) {
      const normPort = normalizePortName(mPort);
      const sPort = shortPortName(normPort);
      if (!seenPorts.has(normPort) && !seenPorts.has(sPort) && !seenPorts.has(mPort) && mInfo.vendor) {
        seenPorts.add(normPort);
        seenPorts.add(sPort);
        seenPorts.add(mPort);
        results.push({
          port: normPort,
          portShort: sPort,
          vendor: mInfo.vendor || '',
          partNumber: mInfo.partNumber || '',
          transceiverType: '',
          wavelength: '',
          serialNumber: mInfo.serialNumber || '',
          temperature: null,
          voltage: null,
          biasCurrent: null,
          rxPower: null,
          txPower: null,
          status: 'no_ddm'
        });
      }
    }
    if (results.length > 0) return results;
  }

  // Fallback tabular format
  const lines = output.split(/\r?\n/);
  let isTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/tx.*power|tx-power/i.test(trimmed) && /rx.*power|rx-power/i.test(trimmed)) {
      isTable = true;
      continue;
    }
    if (isTable) {
      if (trimmed.startsWith('---') || !trimmed || trimmed.startsWith('%')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 6) {
        let port = parts[0];
        let offset = 0;
        if (parts[1] && /^\d+\/\d+/.test(parts[1])) {
          port = `${parts[0]} ${parts[1]}`;
          offset = 1;
        }
        const norm = normalizePortName(port);
        const short = shortPortName(norm);
        const manu = manuMap.get(norm) || manuMap.get(short) || {};
        const rx = parts[5 + offset] === 'NA' ? null : parseFloat(parts[5 + offset]);
        const tx = parts[4 + offset] === 'NA' ? null : parseFloat(parts[4 + offset]);
        results.push({
          port: norm,
          portShort: short,
          vendor: manu.vendor || '',
          partNumber: manu.partNumber || '',
          transceiverType: '',
          wavelength: '',
          serialNumber: manu.serialNumber || '',
          temperature: parseFloat(parts[1 + offset]) || null,
          voltage: parseFloat(parts[2 + offset]) || null,
          biasCurrent: parseFloat(parts[3 + offset]) || null,
          txPower: tx,
          rxPower: rx,
          status: rx === null ? 'no_signal' : getOpticalHealth(rx)
        });
      }
    }
  }

  return results;
}

function getOpticalHealth(rxPower) {
  if (rxPower === null || isNaN(rxPower)) return 'unknown';
  if (rxPower < -20.0) return 'critical';
  if (rxPower < -15.0) return 'warning';
  if (rxPower > 0.0) return 'warning';
  return 'normal';
}

/**
 * Parse `show lldp neighbors detail`
 */
export function parseLLDPNeighbors(output) {
  if (!output || typeof output !== 'string') return [];
  const neighbors = [];

  // Ruijie detail block: LLDP neighbor-information of port [...]
  if (output.includes('LLDP neighbor-information of port')) {
    const blocks = output.split(/----------------------------------------------------------------------------\s*\r?\nLLDP neighbor-information of port \[([^\]]+)\]/i);
    for (let i = 1; i < blocks.length; i += 2) {
      const localPortRaw = blocks[i].trim();
      const body = blocks[i + 1] || '';

      const sysNameMatch = body.match(/^\s*System\s+name\s*:\s*([^\r\n]*)$/m);
      const chassisMatch = body.match(/^\s*Chassis\s+ID\s*:\s*([^\r\n]+)$/m);
      const sysDescMatch = body.match(/^\s*System\s+description\s*:\s*([^\r\n]*)$/m);
      const portIdMatch = body.match(/^\s*Port\s+ID\s*:\s*([^\r\n]+)$/m);
      const portDescMatch = body.match(/^\s*Port\s+description\s*:\s*([^\r\n]+)$/m);
      const capsMatch = body.match(/^\s*System\s+capabilities\s+enabled\s*:\s*([^\r\n]+)$/m);

      const sysName = sysNameMatch ? sysNameMatch[1].trim() : '';
      const chassisId = chassisMatch ? chassisMatch[1].trim() : '';
      const remoteDevice = sysName || chassisId || 'Unknown Device';
      const remoteDesc = sysDescMatch ? sysDescMatch[1].trim() : '';
      const caps = capsMatch ? capsMatch[1].trim() : '';
      const isUplink = /Switch|Router|RGOS/i.test(remoteDesc) || (/Bridge,\s*Router/i.test(caps) && !/WLAN/i.test(caps));

      neighbors.push({
        localPort: normalizePortName(localPortRaw),
        localPortShort: shortPortName(localPortRaw),
        remoteDevice,
        remotePort: portDescMatch ? portDescMatch[1].trim() : (portIdMatch ? portIdMatch[1].trim() : ''),
        capability: caps,
        isUplink
      });
    }
    if (neighbors.length > 0) return neighbors;
  }

  // Fallback: standard table format
  // Device ID            Local Intf          Hold-time Capability  Port ID
  // SW-Core-01           Te0/13              120       B,R         Te0/1
  const lines = output.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/Device\s+ID\s+Local\s+Intf/i)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (trimmed.startsWith('---') || !trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 5) {
        const deviceId = parts[0];
        const localIntf = parts[1];
        const capability = parts[3];
        const remotePort = parts.slice(4).join(' ');
        const isUplink = /B|R|Bridge|Router/i.test(capability) && !/W/i.test(capability);

        neighbors.push({
          localPort: normalizePortName(localIntf),
          localPortShort: shortPortName(localIntf),
          remoteDevice: deviceId,
          remotePort,
          capability,
          isUplink
        });
      }
    }
  }

  return neighbors;
}

/**
 * Parse `show version`
 */
export function parseShowVersion(output) {
  if (!output || typeof output !== 'string') return {};
  const res = { version: '', uptime: '', model: '', serial: '', mac: '' };

  const verMatch = output.match(/(?:Software\s+Version|System\s+software\s+version|Ruijie\s+OS\s+Software\s*,\s*Version)\s*:?\s*([^\r\n]+)/i);
  if (verMatch) res.version = verMatch[1].trim();

  const upMatch = output.match(/(?:uptime\s+is|System\s+uptime)\s*:?\s*([^\r\n]+)/i);
  if (upMatch) res.uptime = upMatch[1].trim();

  const modelMatch = output.match(/(?:Device\s+model|Model\s+name|Product|Slot\s+0\s*:\s*([A-Za-z0-9\-_]+))\s*:?\s*([A-Za-z0-9\-_]+)?/i);
  if (modelMatch) res.model = (modelMatch[1] || modelMatch[2] || '').trim();

  const snMatch = output.match(/(?:Serial\s+Number|Device\s+serial\s+number|S\/N|System\s+serial\s+number)\s*:?\s*([A-Za-z0-9]+)/i);
  if (snMatch) res.serial = snMatch[1].trim();

  const macMatch = output.match(/(?:System\s+MAC\s+Address|Hardware\s+MAC\s+Address|MAC\s+Address|sysmac)\s*:?\s*([0-9a-fA-F:\.\-]+)/i);
  if (macMatch) res.mac = macMatch[1].trim();

  return res;
}
