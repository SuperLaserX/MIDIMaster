// Access Virus TI Polar: the first Virus TI Polar (37-key keyboard). The same editor as the TI2 Desktop (access-virus-ti2.js, docs/devices/access-virus-ti2.md):
// the first TI's OS image (vti.bin, Software Suite 5.1.7) has the TI2's host code except the byte at 000A (07 there,
// 05 in vti_2.bin), the same DSP code (F020-F035) and USB code, and its own ROM banks (P064...).
// Same SysEx (F0 00 20 33 01 dd ...), the same USB ports ("Virus TI Synth", "Virus TI MIDI": one driver, USB ID
// 133E:0815, for every TI) and Virus Control's one description "Virus TI Desktop/Polar/Keyboard". Not checked on
// this model (docs/devices/access-virus-ti-polar.md).
import { tiModel } from './access-virus-ti2.js';

export default tiModel({ model: "Virus TI Polar", note: "its OS image (vti.bin, Software Suite 5.1.7) has the TI2 host code except one byte (000A: 07, in the TI2 image 05), the same DSP code and its own ROM banks (the first TI factory sounds, format 8, shown converted as the OS plays them). Not checked on this model: only a TI2 Desktop was connected." });
