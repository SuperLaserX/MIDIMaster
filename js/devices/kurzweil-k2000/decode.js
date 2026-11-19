// K2000 SysEx descriptions for the MIDI monitor.

import { parse, isK2, MSG } from './protocol.js';
import { typeName } from './model/types.js';
import { hex } from '../../core/bits.js';

export function describeK2(data) {
  if (!isK2(data)) return null;
  try {
    const m = parse(data);
    const obj = m.type !== undefined ? ` ${typeName(m.type)}${m.id !== undefined ? ' ' + m.id : ''}` : '';
    switch (m.msg) {
      case MSG.DUMP: return `K2000 DUMP${obj} offs ${m.offs} size ${m.size}`;
      case MSG.LOAD: return `K2000 LOAD${obj} offs ${m.offs} [${hex(m.data.slice(0, 12))}${m.size > 12 ? ' ...' : ''}] (${m.size} bytes)`;
      case MSG.DACK: return `K2000 DACK${obj} offs ${m.offs}`;
      case MSG.DNAK: return `K2000 DNAK${obj}: ${m.reason}`;
      case MSG.INFO: return `K2000 INFO${obj} "${m.objName}" ${m.size} bytes ${m.inRam ? 'RAM' : 'ROM'}`;
      case MSG.WRITE: return `K2000 WRITE${obj} "${m.objName}" ${m.size} bytes`;
      case MSG.MEMREPLY: return `K2000 MEMORY program ${m.programFreeK} K, samples ${m.sampleFreeK} K free`;
      case MSG.PANEL: return `K2000 PANEL ${m.events.map((e) => `${{ 8: 'up', 9: 'down', 10: 'rpt', 13: 'wheel' }[e.type] || e.type}:${e.button.toString(16)}${e.type === 13 ? `(${e.clicks})` : ''}`).join(' ')}`;
      case MSG.SCREENREPLY: return `K2000 SCREEN reply ${m.data.length} bytes`;
      case MSG.OBJADDRREPLY: return `K2000 ADDRESS${obj} = 0x${m.address.toString(16)}`;
      default: return `K2000 ${m.name}${obj}`;
    }
  } catch (err) { return `K2000 message (unparsed: ${err.message})`; }
}
