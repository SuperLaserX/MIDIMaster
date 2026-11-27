// Access Virus kb (keyboard, 2000): the Virus b's OS 4.9 (its readme: "compatible with the Virus b, kb and Indigo";
// the keyboard settings of its SYSTEM menus apply to it). Editor: access-virus-abc.js with the B OS tables.
import { abcModel, BANKS_AH } from './access-virus-abc.js';
import * as T from './access-virus-b-os.js';

export default abcModel({
  model: 'Virus kb', id: 'access-virus-kb', T, banks: BANKS_AH, panelByte: true,
  note: 'runs the Virus B system software (OS 4.9); the editor is built from it.',
});
