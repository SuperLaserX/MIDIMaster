// Sample Dump Standard transfers for any sampler that supports SDS.

import { h, toast, downloadBlob, pickFiles, safeFileName, formDialog } from '../../../core/ui/dom.js';
import { SampleDump, sdsTransferSeconds } from '../../../core/midi/sds.js';
import { parseWav, writeWav, floatToInt16, mixToMono, resampleLinear } from '../../../core/wav.js';
import { sleep } from '../../../core/bits.js';

export function samplesView(root, g) {
  const st = { sds: null };
  const num = h('input', { type: 'number', min: 0, max: 16383, value: 0 });
  const progress = h('div');
  const label = h('div.small');
  const box = h('div.card.col', { hidden: true }, h('div.row', label, h('span.grow'), h('button.btn.small.danger', { onclick: () => st.sds?.cancel() }, 'Cancel')), h('div.progress', progress));

  async function withSds(fn) {
    if (st.sds) { toast('A transfer is already running', 'warn'); return null; }
    if (!g.connected || !g.transport.input) { toast('Choose both MIDI ports on the Connect page first.', 'warn'); return null; }
    await g.client.drain();
    const sds = new SampleDump(g.transport, g.deviceId);
    sds.packetGap = g.host.settings.value.midi.sdsPacketGap;
    st.sds = sds;
    g.host.exclusive = true;
    box.hidden = false;
    try {
      return await fn(sds, (f, text) => { progress.style.width = `${Math.round(f * 100)}%`; if (text) label.textContent = text; });
    } catch (err) { g.error(err, 'Sample Dump'); return null; } finally {
      st.sds = null; g.host.exclusive = false; box.hidden = true;
    }
  }

  async function receive() {
    const n = Number(num.value);
    await withSds(async (sds, progressFn) => {
      progressFn(0, `Requesting sample ${n}...`);
      const r = await sds.receive(n, (f) => progressFn(f, `Receiving sample ${n}: ${Math.round(f * 100)}%`));
      const loop = r.loop ? { start: r.loopStart, end: r.loopEnd } : null;
      downloadBlob(writeWav([r.samples], r.sampleRate, loop), `${safeFileName(g.entry.model)}_sample_${n}.wav`, 'audio/wav');
      toast(`Sample ${n} received (${r.samples.length} samples at ${r.sampleRate} Hz)`, 'good');
    });
  }

  async function send() {
    const [file] = await pickFiles('.wav,audio/wav');
    if (!file) return;
    let wav;
    try { wav = parseWav(await file.arrayBuffer()); } catch (err) { g.error(err, 'WAV'); return; }
    const r = await formDialog(`Send ${file.name}`, [
      { key: 'number', label: 'Sample number on the device', type: 'number', value: Number(num.value), min: 0, max: 16383 },
      { key: 'rate', label: 'Sample rate', type: 'select', value: String(wav.sampleRate), options: [...new Set([wav.sampleRate, 48000, 44100, 32000, 22050])].map((x) => ({ value: String(x), label: `${x} Hz (about ${Math.ceil(sdsTransferSeconds(Math.round(wav.frames * (x / wav.sampleRate))))} s)` })) },
    ], 'Send', `${wav.frames} frames, ${wav.channels.length} channel(s); stereo files are mixed to mono.`);
    if (!r) return;
    const rate = Number(r.rate);
    const pcm = floatToInt16(resampleLinear(mixToMono(wav.channels), wav.sampleRate, rate));
    const ratio = rate / wav.sampleRate;
    await withSds(async (sds, progressFn) => {
      await sds.send(pcm, {
        number: Number(r.number), sampleRate: rate,
        ...(wav.loop ? { loop: true, loopStart: Math.round(wav.loop.start * ratio), loopEnd: Math.round(wav.loop.end * ratio) } : {}),
        onProgress: (f) => progressFn(f, `Sending to sample ${r.number}: ${Math.round(f * 100)}%`),
      });
      await sleep(300);
      toast('Sample sent', 'good');
    });
  }

  root.append(
    h('h1', 'Samples'),
    h('div.sub', { title: `Each sampler numbers its samples its own way: check the ${g.entry.model} manual if a sample lands somewhere unexpected.` }, 'Sample Dump Standard transfers. Over DIN MIDI, one second of 44.1 kHz audio takes about 45 seconds.'),
    h('div.card.col',
      h('div.row', h('label.field', 'Sample number', num),
        h('button.btn.primary', { onclick: receive }, 'Receive as WAV'),
        h('button.btn', { onclick: send }, 'Send a WAV file')),
      h('div.small.muted', 'Both MIDI cables are needed.')),
    box);
  return { destroy() { st.sds?.cancel(); } };
}
