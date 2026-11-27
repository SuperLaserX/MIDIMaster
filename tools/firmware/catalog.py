"""Build the device catalog from the extracted firmware.

Usage: python -I tools/firmware/catalog.py re/firmware [--out-dir DIR]
Writes tools/firmware/catalog.json (full detail) and js/devices/catalog-data.js (for the app);
with --out-dir both go to DIR instead (to compare a rebuild with the current files first).
Third-party MIDI upgrades (retrofit kits) come from tools/firmware/midi_devices.json: a device there whose
`inCollection` (or `kitInCollection`) names this catalog device ("<maker> <model>") gives its `midiUpgrades`.
Reads files only; nothing is executed.
"""
import collections
import json
import math
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(__file__))
from devices import RULES, TYPE_NAMES  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DOC = re.compile(r'\.(pdf|txt|jpe?g|gif|png|bmp|rtf|docx?|html?|nfo|url|ds_store|md|xls|csv|ini|log)$', re.I)
AUDIO = re.compile(r'\.(wav|aiff?|mp3|flac|raw)$', re.I)
SKIP = re.compile(r'\.(mid|syx|exe|bat|js|par2|zip|rar|7z|com|sys|dll|sh)$', re.I)
PLD = re.compile(r'\.(jed|pal|gal|pld)$', re.I)
DATA_HINT = re.compile(r'sound|pcm|wave|wav|sample|voice ?rom|drum ?rom|cymbal|tom|snare|kick|wavhi|wavlo|tone ?rom', re.I)

# MMA manufacturer IDs of the makers in the collection.
SYSEX_IDS = {
    'Sequential': '01', 'Octave': '03', 'Moog': '04', 'Lexicon': '06', 'Kurzweil': '07', 'ADA': '0D',
    'Garfield Electronics': '0E', 'Ensoniq': '0F', 'Oberheim': '10', 'Apple': '11', 'Digidesign': '13',
    'Fairlight': '14', 'JL Cooper': '15', 'E-mu': '18', 'ART': '1A', 'Eventide': '1C', 'Siel': '21',
    'Hohner': '24', 'Solton': '26', 'PPG': '29', 'Jen': '2A', 'Elka': '2F', 'Dynacord': '30', 'Viscount': '31',
    'Clavia': '33', 'Cheetah': '36', 'Waldorf': '3E', 'Quasimidi': '3F', 'Kawai': '40', 'Roland': '41',
    'Boss': '41', 'Korg': '42', 'Yamaha': '43', 'Casio': '44', 'Akai': '47', 'Sony': '4C', 'Technics': '50',
    'Zoom': '52', 'Suzuki': '55', 'Alesis': '00 00 0E', 'DigiTech': '00 00 10', 'DOD': '00 00 10',
    'Peavey': '00 00 1B', 'MOTU': '00 00 3B', 'Rocktron': '00 00 29', 'Novation': '00 20 29',
    'Behringer': '00 20 32', 'Access': '00 20 33', 'Doepfer': '00 20 20', 'TC Electronic': '00 20 1F',
    'Line 6': '00 01 0C', 'Opcode': '00 00 16', 'Midiman': '00 01 05', 'IBM': '43', 'Creative': '00 20 21',
    'Emagic': '00 20 31', 'Studiologic': '00 00 7F', 'GEM': '00 20 0C', 'Drawmer': '00 20 1D',
}


def entropy(b):
    if not b:
        return 0.0
    c = collections.Counter(b)
    n = len(b)
    return -sum(v / n * math.log2(v / n) for v in c.values())


def be16(b, p):
    return (b[p] << 8) | b[p + 1]


def be32(b, p):
    return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]


def guess_cpu(b):
    """Rough CPU family from reset vectors and entry code. Returns a short label or ''."""
    n = len(b)
    if n < 64:
        return ''
    # 68000: SSP and PC longwords, then exception vectors sharing the PC's high bytes.
    ssp, pc = be32(b, 0), be32(b, 4)
    if pc % 2 == 0 and ssp % 2 == 0 and 0 < pc < 0x01000000 and ssp < 0x01000000:
        vec = [be32(b, i) for i in range(8, 64, 4)]
        same = sum(1 for v in vec if v and (v >> 16) == (pc >> 16) and v % 2 == 0)
        if same >= 6:
            return '68000'
    # SH / 32-bit big-endian vector tables: PC then SP.
    # ARM: branch instructions at 0.
    if all(b[i + 3] == 0xEA for i in range(0, 32, 4)) or (b[3] == 0xEA and b[7] in (0xEA, 0xE5)):
        return 'ARM'
    # 8051 family: LJMP at 0 and interrupt vectors every 8 bytes.
    if b[0] == 0x02 and sum(1 for o in (3, 0x0B, 0x13, 0x1B, 0x23) if b[o] in (0x02, 0x32, 0xFF, 0x00)) >= 4:
        return '8051'
    # Z80 / 8080 / 8085: DI, JP, LD SP at 0; RST slots at 8-byte steps.
    if b[0] in (0xF3, 0xC3, 0x31) and (b[0] != 0x31 or b[3] in (0xC3, 0xF3, 0xCD, 0x3E, 0x21)):
        rst = sum(1 for o in (8, 16, 24, 32, 40, 48, 56) if b[o] in (0xC3, 0xC9, 0xF3, 0xFF, 0xED, 0xE5, 0xF5))
        if rst >= 3:
            return 'Z80/8085'
    # x86 (8088/80186/V25/V50): far jump in the last 16 bytes.
    if n >= 16 and b[n - 16] == 0xEA:
        return 'x86'
    # 8048/8049: JMP at 0 and at 3 (interrupt) and 7 (timer).
    if n <= 4096 and (b[0] & 0x1F) == 0x04 and (b[3] & 0x1F) in (0x04, 0x00) and (b[7] & 0x1F) in (0x04, 0x00, 0x93):
        return '8048'
    # Motorola/MOS 8-bit families: vectors at the end of the ROM.
    rv = be16(b, n - 2)
    top = 0x10000 - n if n <= 0x10000 else 0
    if n <= 0x10000 and top <= rv < 0x10000 and rv != 0xFFFF:
        nmi = be16(b, n - 4)
        if 0x8000 <= nmi < 0x10000 or nmi == 0xFFFF:
            vecs = [be16(b, n - 16 + i) for i in range(0, 16, 2)]
            inrom = sum(1 for v in vecs if top <= v < 0x10000 and v != 0xFFFF)
            if inrom >= 6:
                return '6809/6801/6303'
            return '6800/6502 family'
    # H8/500, H8/300 and similar: 16-bit vectors at 0 pointing into the ROM.
    v0 = be16(b, 0)
    if 0x40 <= v0 < min(n, 0x10000) and be16(b, 2) in (v0, 0, 0xFFFF) or (b[0] == 0 and 0x40 <= be16(b, 0) < 0x1000 and be16(b, 4) < n):
        vecs = [be16(b, i) for i in range(0, 32, 2)]
        if sum(1 for v in vecs if 0x40 <= v < min(n, 0x10000)) >= 10:
            return 'H8/16-bit vectors'
    return ''


EVIDENCE = [
    (re.compile(rb'MIDI', re.I), 'midi'),
    (re.compile(rb'SYS ?EX|EXCLUSIVE', re.I), 'sysex'),
    (re.compile(rb'OMNI', re.I), 'omni'),
]


def evidence(b):
    return {k: len(rx.findall(b)) for rx, k in EVIDENCE}


def read_intel_hex(path):
    out = bytearray()
    base = 0
    try:
        with open(path, encoding='latin1') as f:
            for line in f:
                line = line.strip()
                if not line.startswith(':'):
                    continue
                n = int(line[1:3], 16)
                addr = int(line[3:7], 16)
                typ = int(line[7:9], 16)
                data = bytes.fromhex(line[9:9 + n * 2])
                if typ == 0:
                    a = base + addr
                    if a - len(out) > 0x100000:
                        continue
                    if len(out) < a + n:
                        out.extend(b'\xff' * (a + n - len(out)))
                    out[a:a + n] = data
                elif typ == 2:
                    base = int(line[9:13], 16) << 4
                elif typ == 4:
                    base = int(line[9:13], 16) << 16
    except Exception:
        return None
    return bytes(out)


def strings(b, minlen=6, limit=12):
    out = []
    for m in re.finditer(rb'[\x20-\x7e]{%d,}' % minlen, b):
        s = m.group().decode('latin1').strip()
        if re.search(r'[A-Za-z]{3}', s) and re.search(r'(?i)v\d|ver|copyright|\(c\)|19\d\d|20\d\d|midi|rom|rev', s):
            out.append(s[:80])
            if len(out) >= limit:
                break
    return out


def classify(rel, size):
    name = rel.rsplit('/', 1)[-1]
    if DOC.search(name):
        return 'doc'
    if AUDIO.search(name):
        return 'audio'
    if PLD.search(name):
        return 'pld'
    if name.lower().endswith('.syx'):
        return 'syx'
    if SKIP.search(name):
        return 'other'
    if size < 256:
        return 'other'
    return 'rom'


def norm(s):
    s = unicodedata.normalize('NFD', s)
    return re.sub(r'[^a-z0-9]', '', ''.join(c for c in s if not unicodedata.combining(c)).lower())


def midi_upgrades():
    """norm('<maker> <model>') of a catalog device -> midiUpgrades from tools/firmware/midi_devices.json."""
    path = os.path.join(ROOT, 'tools', 'firmware', 'midi_devices.json')
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding='utf-8') as f:
        db = json.load(f)
    for d in db.get('devices', []):
        ups = d.get('midiUpgrades') or []
        if not ups:
            continue
        for c in (d.get('inCollection') or []) + (d.get('kitInCollection') or []):
            lst = out.setdefault(norm(c['checklistDevice']), [])
            for u in ups:
                if u not in lst:
                    lst.append(u)
    return out


def main(fw_dir, out_dir=None):
    with open(os.path.join(fw_dir, 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    rules = [(rid, mk, md, ty, mi, re.compile(rx, re.I)) for rid, mk, md, ty, mi, rx in RULES]
    devices = {}
    unmatched = []
    for entry in manifest:
        src = entry['source']
        rule = next((r for r in rules if r[5].search(src)), None)
        if not rule:
            unmatched.append(src)
            continue
        rid, mk, md, ty, mi, _ = rule
        dev = devices.setdefault(rid, {
            'id': rid, 'maker': mk, 'model': md, 'type': ty, 'typeName': TYPE_NAMES[ty], 'midi': mi,
            'sysex': SYSEX_IDS.get(mk, ''), 'archives': [], 'cpu': collections.Counter(),
            'evidence': collections.Counter(), 'kinds': collections.Counter(), 'strings': [], 'syxIds': collections.Counter(),
        })
        arch = {'name': src, 'files': []}
        roms = []
        files = entry.get('files', [])
        if entry.get('kind') == 'folder':
            arch['note'] = 'folder of disk files'
        for fi in files[:4000]:
            rel, size = fi['path'], fi['size']
            kind = classify(rel, size)
            dev['kinds'][kind] += 1
            rec = {'path': rel, 'size': size, 'kind': kind}
            full = os.path.join(fw_dir, rel)
            if kind in ('rom', 'syx') and size <= 16 * 1024 * 1024:
                with open(full, 'rb') as fh:
                    b = fh.read()
                if rel.lower().endswith('.hex') and b[:1] == b':':
                    hb = read_intel_hex(full)
                    if hb:
                        b = hb
                if kind == 'syx':
                    for m in re.finditer(rb'\xf0([\x00-\x7f])([\x00-\x7f])([\x00-\x7f])', b):
                        mid = '%02X' % m.group(1)[0] if m.group(1) != b'\x00' else '00 %02X %02X' % (m.group(2)[0], m.group(3)[0])
                        dev['syxIds'][mid] += 1
                else:
                    ev = evidence(b)
                    cpu = guess_cpu(b)
                    ent = entropy(b[:65536])
                    rec.update({'cpu': cpu, 'entropy': round(ent, 2), 'midi': ev['midi'], 'sysex': ev['sysex']})
                    if not cpu and DATA_HINT.search(rel):
                        rec['kind'] = 'data'
                    if cpu:
                        dev['cpu'][cpu] += 1
                    for k, v in ev.items():
                        dev['evidence'][k] += v
                    if len(dev['strings']) < 8:
                        for s in strings(b):
                            if s not in dev['strings']:
                                dev['strings'].append(s)
                    roms.append((rel, b))
            arch['files'].append(rec)
        # ROMs split into even/odd byte halves: interleave equal-size pairs and look again.
        if 2 <= len(roms) <= 16 and not dev['evidence']['midi']:
            bysize = collections.defaultdict(list)
            for rel, b in roms:
                bysize[len(b)].append((rel, b))
            for group in bysize.values():
                for i in range(len(group)):
                    for j in range(len(group)):
                        if i == j:
                            continue
                        a, c = group[i][1], group[j][1]
                        inter = bytes(x for pair in zip(a, c) for x in pair)
                        ev = evidence(inter)
                        if ev['midi']:
                            for k, v in ev.items():
                                dev['evidence'][k + '_interleaved'] += v
                            if not dev['cpu']:
                                cpu = guess_cpu(inter)
                                if cpu:
                                    dev['cpu'][cpu + ' (interleaved)'] += 1
        dev['archives'].append(arch)
    # Final MIDI verdict for unknown devices from the evidence.
    out = []
    for dev in sorted(devices.values(), key=lambda d: (d['maker'].lower(), d['model'].lower())):
        ev = dev['evidence']
        midi_hits = ev['midi'] + ev['midi_interleaved']
        verdict = dev['midi']
        if verdict == '?' and midi_hits >= 2:
            verdict = 'Y?'
        dev['verdict'] = verdict
        dev['cpu'] = [c for c, _ in dev['cpu'].most_common(3)]
        dev['evidence'] = dict(ev)
        dev['kinds'] = dict(dev['kinds'])
        dev['syxIds'] = dict(dev['syxIds'])
        if not dev['sysex'] and dev['syxIds']:
            dev['sysex'] = max(dev['syxIds'], key=dev['syxIds'].get)
        out.append(dev)
    json_dir = out_dir or os.path.join(ROOT, 'tools', 'firmware')
    js_dir = out_dir or os.path.join(ROOT, 'js', 'devices')
    os.makedirs(json_dir, exist_ok=True)
    with open(os.path.join(json_dir, 'catalog.json'), 'w', encoding='utf-8') as f:
        json.dump({'devices': out, 'unmatched': unmatched}, f, indent=1)
    # Compact data for the app.
    app = []
    upgrades = midi_upgrades()
    compact = {}  # placeholder -> compact JSON of a device's midiUpgrades (one line, as the app file has them)
    for d in out:
        rec = {'id': d['id'], 'maker': d['maker'], 'model': d['model'], 'type': d['type'], 'midi': d['verdict']}
        ups = upgrades.get(norm(d['maker'] + ' ' + d['model']))
        if ups:
            ph = '@@midiUpgrades:%s@@' % d['id']
            compact['"%s"' % ph] = json.dumps(ups, ensure_ascii=False, separators=(',', ':'))
            rec['midiUpgrades'] = ph
        rec.update({
            'sysex': d['sysex'], 'cpu': d['cpu'], 'archives': [a['name'] for a in d['archives']],
            'evidence': {k: v for k, v in d['evidence'].items() if v}, 'strings': d['strings'][:6],
        })
        app.append(rec)
    js = ('// Generated by tools/firmware/catalog.py from the firmware collection. Do not edit.\n'
          '// midi: Y yes, N no, R some versions/retrofit, H host computer, D data only, ? unknown, Y? likely (strings)\n'
          'export const CATALOG = ' + json.dumps(app, ensure_ascii=False, indent=0).replace('\n', '') + ';\n')
    js = js.replace('},{', '},\n{')
    for ph, ups in compact.items():
        js = js.replace(ph, ups)
    os.makedirs(js_dir, exist_ok=True)
    with open(os.path.join(js_dir, 'catalog-data.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    counts = collections.Counter(d['verdict'] for d in out)
    print(f'{len(out)} devices from {len(manifest)} archives; unmatched {len(unmatched)}; with MIDI upgrades {len(compact)}')
    print('midi verdicts:', dict(counts))
    for u in unmatched:
        print('  UNMATCHED', u)


if __name__ == '__main__':
    a = sys.argv[1:]
    od = None
    if '--out-dir' in a:
        i = a.index('--out-dir')
        od = os.path.abspath(a[i + 1])
        del a[i:i + 2]
    main(a[0], od)
