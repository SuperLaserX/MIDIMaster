// Access Virus A (1997, desktop): the A / B / C editor (access-virus-abc.js) with the tables of its last OS, 2.8 (the
// update Virus_A_Series_OS280, first MIDI file). Single banks A-D (its menus' SelectBank list): RAM A-B, ROM C-D assumed.
import { abcModel } from './access-virus-abc.js';
import * as T from './access-virus-a-os.js';

export const BANKS_AD = [[1, 'RAM A', true], [2, 'RAM B', true], [3, 'ROM C', false], [4, 'ROM D', false]];

export default abcModel({
  model: 'Virus A', id: 'access-virus-a', T, banks: BANKS_AD, panelByte: true,
  note: 'mapped from its OS 2.8 (docs/devices/access-virus-a.md; banks C-D read only and the sound format 6 assumed).',
});
