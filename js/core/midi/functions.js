// Functions a controller can be mapped to (MIDI inputs: CC n -> a function), and how a function finds
// its parameter on the device that is open. A global mapping names a function ("Filter Cutoff"); each
// device resolves it to one of its own parameters by the parameter's label and group, or the device's
// own mapping names the parameter exactly (it overrides the global one).

/**
 * Synth functions. re: a label that means it; weak: a label that means it only inside a matching
 * group (a bare "Frequency" in a filter card); group: the cards it belongs in (+2); need: only there;
 * avoid: labels or cards that never mean it (key follow, velocity, other envelopes...); prefer: +1.
 */
const ENV_AVOID = /filter|vcf|tvf|vdf|pitch|lfo|\bmod\b|reverb|delay|gate|velo|key|osc \d (time|pw)|aftertouch|joystick/i;
const AMP = /amp|tva|vca|vda|amplifier|level\)/i;
export const FUNCTIONS = [
  { id: 'volume', label: 'Volume (sound level)', re: /^(patch |program |voice |tone |part |single |multi |master |output |amp |tva |vda )?(level|volume)$/i, group: /common|amp|output|tva|vca|vda|voice/i, avoid: /\bop(erator)? ?\d|osc|lfo|send|mfx|chorus|reverb|delay|key|velo|sens|aftertouch/i },
  { id: 'pan', label: 'Pan', re: /^(patch |tone |part |tva |amp )?pan(orama|pot)?$/i, group: /common|amp|output|tva/i, avoid: /key|lfo|\bvelo/i },
  { id: 'cutoff', label: 'Filter Cutoff', re: /cut ?off( freq(uency)?)?$|^(vcf|tvf|vdf|filter) ?(freq(uency)?|cutoff)$/i, weak: /^freq(uency)?$/i, group: /filter|vcf|tvf|vdf|flt/i, avoid: /slope|follow|track|\bkf\b|key|env|lfo|\bmg\b|velo|sens|aftertouch|joystick|depth|\bby\b/i },
  { id: 'resonance', label: 'Filter Resonance', re: /resonance$|^reso$|^emphasis$|^(filter |vcf |tvf )?q$|^peak$/i, group: /filter|vcf|tvf|vdf|flt/i, avoid: /key|velo|env|lfo|\bby\b|depth|aftertouch|joystick/i },
  { id: 'filter-env', label: 'Filter Envelope Amount', re: /(env(elope)?|eg) ?(depth|amount|amt|int(ensity)?)$|^f-env depth$|freq by env/i, group: /filter|vcf|tvf|vdf|flt/i, need: true, avoid: /velo|key|aftertouch|joystick|pitch/i },
  { id: 'attack', label: 'Amp Envelope Attack', re: /attack( time)?$/i, group: AMP, avoid: ENV_AVOID },
  { id: 'decay', label: 'Amp Envelope Decay', re: /decay( time)?$/i, group: AMP, avoid: ENV_AVOID },
  { id: 'sustain', label: 'Amp Envelope Sustain', re: /sustain( level)?$/i, group: AMP, avoid: ENV_AVOID },
  { id: 'release', label: 'Amp Envelope Release', re: /release( time)?$/i, group: AMP, avoid: ENV_AVOID },
  { id: 'lfo-rate', label: 'LFO Rate', re: /rate$|speed$|freq(uency)?$/i, group: /lfo|\bmg\b/i, need: true, avoid: /key|velo|delay|fade|sync|\bby\b|aftertouch|joystick/i },
  { id: 'lfo-depth', label: 'LFO Depth', re: /depth$|amount$|amt$|intensity$/i, group: /lfo|vibrato|\bmg\b/i, need: true, avoid: /key|velo|select|wheel|\bby\b|aftertouch|joystick|-->/i, prefer: /pitch|\bpm\b/i },
  { id: 'portamento', label: 'Portamento Time', re: /portamento( time| rate)?$|glide( time)?$|porta(mento)? ?time$/i, avoid: /legato|mode|switch|\bvelo/i, prefer: /time|rate/i },
  { id: 'fx-level', label: 'Effect Level', re: /(reverb|effect|fx|delay|chorus|mfx|efx).*(level|send|mix|amount)$|^(level|send|mix|output level)$/i, group: /effect|fx|reverb|delay|chorus/i, need: true, avoid: /input mix|feedback/i },
];
export const FUNCTION_BY_ID = new Map(FUNCTIONS.map((f) => [f.id, f]));

/** App actions a controller can start. */
export const ACTIONS = [
  { id: 'program-next', label: 'Next program (program change +1)' },
  { id: 'program-prev', label: 'Previous program (program change -1)' },
  { id: 'panic', label: 'All notes off (panic)' },
];

/** Human-readable target. t: {type: 'function'|'param'|'action'|'cc'|'none', ...}. */
export function targetText(t, paramLabel = null) {
  if (!t) return '-';
  if (t.type === 'function') return FUNCTION_BY_ID.get(t.fn)?.label || t.fn;
  if (t.type === 'param') return paramLabel || `${t.object}: ${t.param}`;
  if (t.type === 'action') return ACTIONS.find((a) => a.id === t.action)?.label || t.action;
  if (t.type === 'cc') return `CC ${t.cc} on the device's channel`;
  if (t.type === 'none') return 'Nothing (block it)';
  return '-';
}

/**
 * The parameter of `params` that function `fnId` means on this device, or null. groupOf(p) gives the
 * text to match the group pattern against (the card and section). Hidden, read-only and text
 * parameters are skipped; among equals the first wins (Osc/Filter/Tone 1 before 2).
 */
export function resolveFunction(fnId, params, { groupOf = (p) => `${p.group || ''} ${p.section || ''}`, usable = () => true } = {}) {
  const f = FUNCTION_BY_ID.get(fnId);
  if (!f) return null;
  let best = null;
  let bestScore = 0;
  for (const p of params) {
    if (p.readOnly || p.hidden || p.kind === 'char' || !usable(p)) continue;
    const label = String(p.label || '').trim();
    const group = groupOf(p);
    const inGroup = f.group ? f.group.test(group) || f.group.test(label) : false;
    if (!f.re.test(label) && !(f.weak && inGroup && f.weak.test(label))) continue;
    if (f.need && !inGroup) continue;
    if (f.avoid && (f.avoid.test(group) || f.avoid.test(label))) continue;
    const score = 1 + (inGroup ? 2 : 0) + (f.prefer?.test(label) ? 1 : 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

/** A 0-127 controller value scaled onto parameter p's range (option lists by position). */
export function scaleToParam(p, value7, range) {
  const v = Math.max(0, Math.min(127, value7)) / 127;
  if (p.options?.length) {
    const opts = p.options;
    return opts[Math.min(opts.length - 1, Math.round(v * (opts.length - 1)))][0];
  }
  return Math.round(range.min + v * (range.max - range.min));
}
