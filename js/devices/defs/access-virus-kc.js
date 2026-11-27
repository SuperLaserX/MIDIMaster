// Access Virus KC (keyboard, 2002): the Virus C's OS 6.6 (its boot text "V I R U S    K C" when IRAM 75h = 1; the
// keyboard settings of its SYSTEM menus apply to it). Editor: access-virus-abc.js with the C OS tables.
import { abcModel, BANKS_AH, C_PANEL } from './access-virus-abc.js';
import * as T from './access-virus-c-os.js';

export default abcModel({
  model: 'Virus KC', id: 'access-virus-kc', T, banks: BANKS_AH, format: 7, panel: C_PANEL,
  note: 'runs the Virus C system software (OS 6.6); the editor is built from it.',
});
