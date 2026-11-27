// Access Virus Indigo (keyboard, 2002): the Virus b's OS 4.9 (its boot text "VIRUS Indigo"). Editor: access-virus-abc.js
// with the B OS tables.
import { abcModel, BANKS_AH } from './access-virus-abc.js';
import * as T from './access-virus-b-os.js';

export default abcModel({
  model: 'Virus Indigo', id: 'access-virus-indigo', T, banks: BANKS_AH, panelByte: true,
  note: 'runs the Virus B system software (OS 4.9); the editor is built from it.',
});
