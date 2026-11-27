// Access Virus Indigo 2 (keyboard, 2003): the Virus C's OS 6.6 (its boot text "I n d i g o  2" when IRAM 75h is 2 or
// more). Editor: access-virus-abc.js with the C OS tables.
import { abcModel, BANKS_AH, C_PANEL } from './access-virus-abc.js';
import * as T from './access-virus-c-os.js';

export default abcModel({
  model: 'Virus Indigo 2', id: 'access-virus-indigo2', T, banks: BANKS_AH, format: 7, panel: C_PANEL,
  note: 'runs the Virus C OS 6.6 (its boot text "Indigo 2"); mapped from that OS (docs/devices/access-virus-c.md).',
});
