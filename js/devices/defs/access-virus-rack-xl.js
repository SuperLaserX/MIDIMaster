// Access Virus Rack XL (2002, 2U rack): the A / B / C editor (access-virus-abc.js) with the tables of its own OS 6.5
// build 079 (the update's first MIDI file): the C's sound engine and SysEx, its own menus (11 edit modes) and four
// parameter knobs whose parameters follow the menu page shown.
import { abcModel, BANKS_AH, RXL_PANEL } from './access-virus-abc.js';
import * as T from './access-virus-rack-xl-os.js';

export default abcModel({
  model: 'Virus Rack XL', id: 'access-virus-rack-xl', T, banks: BANKS_AH, format: 7, panel: RXL_PANEL,
  note: 'mapped from its own OS 6.5 build 079 (docs/devices/access-virus-rack-xl.md).',
});
