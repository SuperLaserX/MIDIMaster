// Access Virus Classic (2004): the Virus B's engine with its own OS build 4.9 x061 (boot text "VIRUS CLASSIC"), from
// the update's first MIDI file. Editor: access-virus-abc.js with the Classic OS tables.
import { abcModel, BANKS_AH } from './access-virus-abc.js';
import * as T from './access-virus-classic-os.js';

export default abcModel({
  model: 'Virus Classic', id: 'access-virus-classic', T, banks: BANKS_AH, panelByte: true,
  note: 'mapped from its own OS 4.9 (build 061; docs/devices/access-virus-b.md).',
});
