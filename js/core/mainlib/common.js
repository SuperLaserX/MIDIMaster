// The shared synth model ("common", version 1): how a patch is described independently of the
// device, so a translator per device can move patches between instruments. Every field is
// optional; a translator fills what its device has and reads what it understands, and reports
// the rest. Continuous amounts are normalised: 0..1 for levels, times and rates whose units differ
// between instruments, -1..1 for bipolar depths, semitones and cents where pitch is meant.
//
// {
//   model: 1, kind: 'patch',
//   voice:   { mode: 'poly'|'mono'|'legato'|'unison', portamento: {on, time}, bendUp, bendDown (semitones),
//              unisonDetune (cents), octave (-2..2) },
//   osc: [   { wave, coarse (semitones, or 'wide-'|'wide+'), fine (cents), control1, control2 (0..1, wave
//              specific: detune, pulse width, mix...), pulseWidth, pwmDepth, sync } ],
//            waves: 'saw' 'square' 'triangle' 'sine' 'noise' 'supersaw' 'triangle-mod' 'feedback' or
//            'rom:<name>' / 'sample:<id>' for sample-based instruments
//   mix:     { balance (-1 osc1 .. 1 osc2), crossMod, ring },
//   pitch:   { lfo1, lfo2, envDepth, env: {attack, decay}, target: 'osc1+2'|'osc2'|'xmod' },
//   filter:  { type: 'lpf'|'hpf'|'bpf', slope (dB/oct), cutoff, resonance, keyTrack, envDepth, lfo1, lfo2,
//              env: {attack, decay, sustain, release} },
//   amp:     { level, lfo1, lfo2, pan: 'off'|'auto'|'manual', env: {attack, decay, sustain, release} },
//   lfo: [   { wave: 'triangle'|'saw'|'square'|'sample-hold'|'sine', rate, fade }, { rate, target } ],
//   tone:    { bass, treble },
//   effects: { modulation: {type, level}, delay: {type, time, feedback, level} },
//   velocity:   { on, depths: {<knob name>: -1..1} },
//   controller: { depths: {<knob name>: -1..1} },
//   extra:   { family, model, ...exact device data a translator of the same family can reuse }
// }
//
// A translator returns from fromCommon: { data, report: { mapped: [], approximated: [], dropped: [] } }.

export const COMMON_MODEL = 1;

export const unit = (v, max = 127) => Math.max(0, Math.min(1, v / max));
export const fromUnit = (u, max = 127) => Math.max(0, Math.min(max, Math.round((u ?? 0) * max)));
/** -1..1 from a value centred at `centre` (e.g. 0..127 with 64 = 0). */
export const bipolar = (v, centre = 64, span = 63) => Math.max(-1, Math.min(1, (v - centre) / span));
export const fromBipolar = (b, centre = 64, span = 63, max = 127) => Math.max(0, Math.min(max, Math.round(centre + (b ?? 0) * span)));

export const emptyReport = () => ({ mapped: [], approximated: [], dropped: [] });
