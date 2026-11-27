// Access Virus TI2 Polar: the Virus TI2 Polar (37-key keyboard). The same editor as the TI2 Desktop (access-virus-ti2.js, docs/devices/access-virus-ti2.md):
// Desktop, Keyboard and Polar run the same TI2 OS image (vti_2.bin, Software Suite 5.1.7).
// Same SysEx (F0 00 20 33 01 dd ...), the same USB ports ("Virus TI Synth", "Virus TI MIDI": one driver, USB ID
// 133E:0815, for every TI) and Virus Control's one description "Virus TI Desktop/Polar/Keyboard". Not checked on
// this model (docs/devices/access-virus-ti2-polar.md).
import { tiModel } from './access-virus-ti2.js';

export default tiModel({ model: "Virus TI2 Polar", note: "the Desktop, Keyboard and Polar run the same TI2 system software; the editor was checked on a TI2 Desktop. Not checked on this model." });
