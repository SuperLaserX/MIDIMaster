// DigiTech DSP-256XL: the editor from its EPROM archived as v1.08 (its version page says 1.04; 64 KB); see docs/devices/digitech-dsp256xl.md. The editor itself is
// shared with the other model of the family (digitech-dsp256-common.js); this file names the model and its tables.

import * as FW from './digitech-dsp256xl-fw.js';
import { makeDsp256 } from './digitech-dsp256-common.js';

const M = makeDsp256(FW, { id: 'digitech-dsp256xl', name: 'DSP-256XL' });

export const {
  FIRMWARE, CONFIGS, TABLES, UTILITY, PRESETS, LAYOUT, PROG, TITLE_LEN, SIZE, DUMP_SIZE, AT, FIRST, isDsp256, pairs, unpairs,
  requestAll, programMessage, allMessage, programChange, parse, isRequest, configOf, configInfo, isTitleChar, titleOf, setTitle,
  PRESET_NAMES, factory, programFromDump, programIntoDump, memoryOf, pageOf, textOf, tableOf, groupOf, programParams, paramOf,
  findPage, writeAndLoad, settingsParams, blocksOf, _test,
} = M;
export default M.def;
