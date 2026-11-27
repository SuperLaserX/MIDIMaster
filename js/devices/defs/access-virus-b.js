// Access Virus b (desktop, 1999): the A / B / C editor (access-virus-abc.js) with the tables of the Virus B OS 4.9
// (the update's T build 049 = the VB_490T flash dump; the same OS runs the Virus kb and the Indigo).
import { abcModel, BANKS_AH } from './access-virus-abc.js';
import * as T from './access-virus-b-os.js';

export default abcModel({
  model: 'Virus b', id: 'access-virus-b', T, banks: BANKS_AH, panelByte: true,
  note: 'built from its system software (OS 4.9, shared with the kb and Indigo).',
});
