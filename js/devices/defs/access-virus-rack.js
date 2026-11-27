// Access Virus Rack (2000): the Virus B's sound engine in a rack. No Rack OS is in the firmware collection, so this
// editor assumes the Virus B OS 4.9's parameters, ranges and texts (the Rack plays B sounds and takes the B's SysEx;
// its own smaller panel and menus are not mapped). Editor: access-virus-abc.js with the B OS tables.
import { abcModel, BANKS_AH } from './access-virus-abc.js';
import * as T from './access-virus-b-os.js';

export default abcModel({
  model: 'Virus Rack', id: 'access-virus-rack', T, banks: BANKS_AH, panelByte: true,
  note: 'assumed to work like the Virus B (OS 4.9): the Rack\'s own system software was not available.',
});
