// Access Virus C (desktop, 2002): the A / B / C editor (access-virus-abc.js) with the tables of the Virus C OS 6.6 (the
// flash dump am29f040b_6v6; the same OS runs the Virus KC and the Indigo 2: IRAM 75h picks the boot text, 5E9B).
import { abcModel, BANKS_AH, C_PANEL } from './access-virus-abc.js';
import * as T from './access-virus-c-os.js';

export default abcModel({
  model: 'Virus C', id: 'access-virus-c', T, banks: BANKS_AH, format: 7, panel: C_PANEL,
  note: 'built from its system software (OS 6.6, shared with the KC and Indigo 2).',
});
