// Option lists from the SuperNova II Rack OS 2.0 firmware (the menu field descriptors named in
// docs/devices/novation-supernova2.md), extracted with re/sn2/work tools. Generated; do not edit by hand.

export const PAN = ["L 63", "L 62", "L 61", "L 60", "L 59", "L 58", "L 57", "L 56", "L 55", "L 54", "L 53", "L 52", "L 51", "L 50", "L 49", "L 48", "L 47", "L 46", "L 45", "L 44", "L 43", "L 42", "L 41", "L 40", "L 39", "L 38", "L 37", "L 36", "L 35", "L 34", "L 33", "L 32", "L 31", "L 30", "L 29", "L 28", "L 27", "L 26", "L 25", "L 24", "L 23", "L 22", "L 21", "L 20", "L 19", "L 18", "L 17", "L 16", "L 15", "L 14", "L 13", "L 12", "L 11", "L 10", "L 09", "L 08", "L 07", "L 06", "L 05", "L 04", "L 03", "L 02", "L 01", "Mid", "Mid", "R 01", "R 02", "R 03", "R 04", "R 05", "R 06", "R 07", "R 08", "R 09", "R 10", "R 11", "R 12", "R 13", "R 14", "R 15", "R 16", "R 17", "R 18", "R 19", "R 20", "R 21", "R 22", "R 23", "R 24", "R 25", "R 26", "R 27", "R 28", "R 29", "R 30", "R 31", "R 32", "R 33", "R 34", "R 35", "R 36", "R 37", "R 38", "R 39", "R 40", "R 41", "R 42", "R 43", "R 44", "R 45", "R 46", "R 47", "R 48", "R 49", "R 50", "R 51", "R 52", "R 53", "R 54", "R 55", "R 56", "R 57", "R 58", "R 59", "R 60", "R 61", "R 62", "R 63"];
export const REVERB_TYPES = ["Gated reverse", "Gated rising", "Gated gentle", "Gated falling", "Dry chamber", "Echo chamber", "Small room", "Big room", "Medium type 1", "Medium type 2", "Medium plate 1", "Medium plate 2", "Large type 1", "Large type 2", "Large plate 1", "Large plate 2"];
export const FX_CONFIGS = ["D + R + C", "D > R > C", "D > C > R", "R > D > C", "R > C > D", "C > D > R", "C > R > D", "D + [R>C]", "D + [C>R]", "R + [D>C]", "R + [C>D]", "C + [D>R]", "C + [R>D]", "D > [R+C]", "R > [D+C]", "C > [D+R]", "[R+C] > D", "[D+C] > R", "[D+R] > C"];
export const PASS_TO_FX = ["Program only", "Audio input (1) only", "Program & input (1)", "Audio input (2) only", "Program & input (2)"];
export const DELAY_RATIOS = ["1:1", "1:0.75", "0.75:1", "1:0.66", "0.66:1", "1:0.5", "0.5:1", "1:0.33", "0.33:1", "1:0.25", "0.25:1", "1:Off", "Off:1"];
export const CHORUS_TYPES = ["Phaser", "Chorus/flanger", "Quad chorus", "Ensemble", "Rotary speaker"];
export const CHORUS_LFO = ["Sine", "-63", "-62", "-61", "-60", "-59", "-58", "-57", "-56", "-55", "-54", "-53", "-52", "-51", "-50", "-49", "-48", "-47", "-46", "-45", "-44", "-43", "-42", "-41", "-40", "-39", "-38", "-37", "-36", "-35", "-34", "-33", "Far peak", "-31", "-30", "-29", "-28", "-27", "-26", "-25", "-24", "-23", "-22", "-21", "-20", "-19", "-18", "-17", "-16", "-15", "-14", "-13", "-12", "-11", "-10", "-09", "-08", "-07", "-06", "-05", "-04", "-03", "-02", "-01", "Triangle", "+01", "+02", "+03", "+04", "+05", "+06", "+07", "+08", "+09", "+10", "+11", "+12", "+13", "+14", "+15", "+16", "+17", "+18", "+19", "+20", "+21", "+22", "+23", "+24", "+25", "+26", "+27", "+28", "+29", "+30", "+31", "Near peak", "+33", "+34", "+35", "+36", "+37", "+38", "+39", "+40", "+41", "+42", "+43", "+44", "+45", "+46", "+47", "+48", "+49", "+50", "+51", "+52", "+53", "+54", "+55", "+56", "+57", "+58", "+59", "+60", "+61", "+62", "Sine"];
export const PAN_TYPES = ["Autopan", "Tremolo", "L - R", "R - L"];
export const VOC_MODES = ["Vocoder off", "Carrier >> Vocoder", "Vocoder only", "Vocoder << Modulator", "Modulator only"];
export const VOC_INPUT = ["Input (1)", "Input (2)", "Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6", "Part 7", "Part 8"];
export const VOC_INSERT = ["Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6", "Part 7", "Part 8"];
export const WHEEL_MODE = ["FX amount", "Threshold"];
export const CLOCK_MULT = ["No", "2", "3", "4", "6", "8", "9", "12", "16", "18", "24", "32", "36", "48", "64", "72", "96", "128", "144", "192", "256", "288", "320", "384", "432", "448", "480", "512", "576", "672", "720", "768", "864", "1008", "1152"];
// Pedal/breath (menu field 6CEC8)
export const PEDAL_BREATH = ["Off", "MW", "A/T", "CC3", "CC4", "CC5", "CC6", "CC7", "CC8", "CC9", "CC10", "CC11", "CC12", "CC13", "CC14", "CC15", "CC16", "CC17", "CC18", "CC19", "CC20", "CC21", "CC22", "CC23", "CC24", "CC25", "CC26", "CC27", "CC28", "CC29", "CC30", "CC31", "CC32", "CC33", "CC34", "CC35", "CC36", "CC37", "CC38", "CC39", "CC40", "CC41", "CC42", "CC43", "CC44", "CC45", "CC46", "CC47", "CC48", "CC49", "CC50", "CC51", "CC52", "CC53", "CC54", "CC55", "CC56", "CC57", "CC58", "CC59", "CC60", "CC61", "CC62", "CC63", "CC64", "CC65", "CC66", "CC67", "CC68", "CC69", "CC70", "CC71", "CC72", "CC73", "CC74", "CC75", "CC76", "CC77", "CC78", "CC79", "CC80", "CC81", "CC82", "CC83", "CC84", "CC85", "CC86", "CC87", "CC88", "CC89", "CC90", "CC91", "CC92", "CC93", "CC94", "CC95", "CC96", "CC97", "CC98", "CC99", "CC100", "CC101", "CC102", "CC103", "CC104", "CC105", "CC106", "CC107", "CC108", "CC109", "CC110", "CC111", "CC112", "CC113", "CC114", "CC115", "CC116", "CC117", "CC118", "CC119", "Bend", "Bend+", "Bend-", "N75", "N76", "N77", "N95", "N96"];
// Sysex transmission, in menu order (menu field 6CDDC)
export const SYSEX_TX = ["Single program", "All programs", "Single prog request", "All progs request", "Single performance", "All performances", "Single perf request", "All perfs request", "Single arp pattern", "All arp patterns", "Single patt request", "All patts request", "Global parameters", "Globals request", "Program bank A", "Program bank B", "Program bank C", "Program bank D", "Program bank E", "Program bank F", "Program bank G", "Program bank H", "Prog bank A request", "Prog bank B request", "Prog bank C request", "Prog bank D request", "Prog bank E request", "Prog bank F request", "Prog bank G request", "Prog bank H request", "Performance bank A", "Performance bank B", "Performance bank C", "Performance bank D", "Perf bank A request", "Perf bank B request", "Perf bank C request", "Perf bank D request", "Drum map a", "Drum map b", "Drum map c", "Drum map d", "Drum map e", "Drum map f", "Drum map g", "Drum map h", "Drum map a request", "Drum map b request", "Drum map c request", "Drum map d request", "Drum map e request", "Drum map f request", "Drum map g request", "Drum map h request", "Patt bank U", "Patt bank V", "Patt bank W", "Patt bank U request", "Patt bank V request", "Patt bank W request", "Total data", "Total data request"];
// Sysex reception, in menu order (menu field 6CE4E)
export const SYSEX_RX = ["Disabled", "Normal (Rx as sent)", "All progs to bank A", "All progs to bank B", "All progs to bank C", "All progs to bank D", "All progs to bank E", "All progs to bank F", "All progs to bank G", "All progs to bank H", "All progs to Dmap a", "All progs to Dmap b", "All progs to Dmap c", "All progs to Dmap d", "All progs to Dmap e", "All progs to Dmap f", "All progs to Dmap g", "All progs to Dmap h", "All perfs to bank A", "All perfs to bank B", "All perfs to bank C", "All perfs to bank D", "All patts to user(U)", "All patts to user(V)", "All patts to user(W)"];
// Breath mode (menu field 6CF10)
export const BREATH_MODE = ["Absolute", "Mod. +", "Mod. -"];
// Breath sensing, menu order (menu field 6CF44)
export const BREATH_SENSING = ["-5", "-4", "-3", "-2", "-1", "Norm", "+1", "+2", "+3", "+4", "+5"];
// Input/sw 1 and 2 (menu field 6D0FC)
export const INPUT_SW = ["Audio in", "Switch", "Switch-I"];
// Pedal/sw 3 (values 12-15) (menu field 6D174)
export const PEDAL_SW3 = ["Pedal-R", "Pedal-T", "Switch", "Switch-I"];
// Arp pattern editing via MIDI (menu field 6D5C4)
export const VIA_MIDI = ["Off", "On", "Note only", "Vel only", "Gate only"];
// Digital I/O option: sample rate (menu field 6DF90)
export const SAMPLE_RATE = ["32Khz", "44.1Khz", "48Khz"];
// Digital I/O option: sync (menu field 6DFBA)
export const DIG_SYNC = ["Auto", "Internal", "Electrical", "Optical", "Word clock"];
// Digital I/O option: optical in (menu field 6DFFE)
export const OPT_IN = ["ADAT", "SPDIF 3 & 4"];
// Digital I/O option: optical out (menu field 6E02A)
export const OPT_OUT = ["ADAT", "SPDIF 1 & 2", "SPDIF 3 & 4", "SPDIF 5 & 6", "SPDIF 7 & 8"];
// Digital I/O option: electrical in (menu field 6E070)
export const ELECT_IN = ["Off", "SPDIF 1 & 2"];
// Digital I/O option: electrical out (menu field 6E09E)
export const ELECT_OUT = ["1 & 2", "3 & 4", "5 & 6", "7 & 8"];
