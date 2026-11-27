"""Write js/devices/defs/access-virus-ti2-fw.js from the Virus Control parameter description.

usage: python -I gen_fw.py [ti.json] [out.js]
  defaults: re/virusti/vc/ti.json (made by vc_xml.py) -> js/devices/defs/access-virus-ti2-fw.js

Tables written (all names and value texts are Virus Control's own, see docs/devices/access-virus-ti2.md):
  LISTS   value lists: name -> [[raw value, text], ...] in Virus Control's display order
  BIAS    value lists that are plain numbers: name -> k (text = raw + k, with '+' for k-shifted bipolar ones)
  CONDS   Virus Control's visibility/active conditions: name -> [op, [[parameter, min, max], ...], invert]
  SINGLE  single dump bytes: [offset, [key, label, group, min, max, default, list, condition], ...more meanings]
  MULTI   multi dump: common [offset, key, label, group, min, max, default, list]
  MPART   per-part multi parameters: [page-72 index, key, label, min, max, default, list]
  MBITS   per-part switches in multi bytes 240-255: [bit, key, label, list]
  GLOBAL  global parameters (page 73): [index, key, label, group, min, max, default, list, condition]
  INTERN  page 74 (Virus Control's internal messages): [index, key, label]
"""
import json
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'z:/MIDIMaster/re/virusti/vc/ti.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'z:/MIDIMaster/js/devices/defs/access-virus-ti2-fw.js'

J = json.load(open(SRC, encoding='utf-8'))
P = J['params']
V = J['valuelists']

PAGE = {'cc': 0, 'pp': 1, 'Bank A (70) Single-1': 0, 'Bank B (71) Single-2': 1, 'Bank C (6E) Single-3': 2, 'Bank D (6F) Single-4': 3}


def clean(s):
    return re.sub(r'\s+', ' ', (s or '').replace('^', '\u00b0')).strip()


def label_of(key):
    p = P[key]
    d = clean(p['display'] or p['name'])
    if d in ('', '*'):
        d = clean(p['name'])
    s = p['set']
    if d.startswith(s + '/'):
        d = d[len(s) + 1:]
    elif '/' in d:
        d = d.split('/', 1)[1]
    return d


used_lists = set()


def lst(name):
    if name and name in V:
        used_lists.add(name)
        return name
    return None


def variant(key):
    p = P[key]
    return [key, label_of(key), p['set'], p['min'], p['max'], p['def'], lst(p['vl']), p['cond'] or None]


# ------------------------------------------------------------------ single dump
single = {}
for b in J['messages']['VirusTI_Singledump']:
    if b.get('type') != 'parameter':
        continue
    i = int(b['index'])
    off = i - 9 if i < 265 else i - 10
    p = P[b['content']]
    assert PAGE[p['msg']] * 128 + p['ci'] == off, (b['content'], off)
    assert not b.get('mask'), b
    single.setdefault(off, []).append(variant(b['content']))
single_rows = [[off, *vs] for off, vs in sorted(single.items())]
unmapped = [o for o in range(512) if o not in single]

# ------------------------------------------------------------------ multi dump
multi_common, mpart, mbits = [], {}, {}
for b in J['messages']['VirusTI_MultiDump']:
    if b.get('type') != 'parameter':
        continue
    i = int(b['index'])
    off = i - 9
    key = b['content']
    p = P[key]
    if b.get('part') is None:
        multi_common.append([off, key, label_of(key), p['set'], p['min'], p['max'], p['def'], lst(p['vl'])])
    elif b.get('mask'):
        mbits.setdefault(int(b['shift']), [int(b['shift']), key, label_of(key), lst(p['vl'])])
        assert off == 240 + int(b['part']), (key, off)
    else:
        part = int(b['part'])
        assert off == 32 + 16 * (p['ci'] - 32) + part, (key, off, p['ci'])
        mpart.setdefault(p['ci'], [p['ci'], key, label_of(key), p['min'], p['max'], p['def'], lst(p['vl'])])
# Multi parameters Virus Control edits by message but does not place in its dump description
for key, p in P.items():
    if p['msg'] == 'Bank E (72) Multi' and p['part'] == 'all' and 32 <= p['ci'] <= 47 and p['ci'] not in mpart:
        mpart[p['ci']] = [p['ci'], key, label_of(key), p['min'], p['max'], p['def'], lst(p['vl'])]
for key, p in P.items():
    if p['msg'] == 'Bank E (72) Multi' and p['part'] != 'all' and not any(r[1] == key for r in multi_common):
        multi_common.append([p['ci'], key, label_of(key), p['set'], p['min'], p['max'], p['def'], lst(p['vl']), 'not in the dump description'])

# ------------------------------------------------------------------ global / intern
glob = []
intern = []
for key, p in P.items():
    if p['msg'] == 'Bank F (73) Global':
        glob.append([p['ci'], key, label_of(key), p['set'], p['min'], p['max'], p['def'], lst(p['vl']), p['cond'] or None])
    elif p['msg'] == 'Bank G (74) Intern':
        intern.append([p['ci'], key, label_of(key)])
glob.sort(key=lambda r: (r[0], r[1]))
intern.sort()

# ------------------------------------------------------------------ conditions (only those used)
conds = {}
for rows in (single.values(),):
    for vs in rows:
        for v in vs:
            if v[7]:
                conds[v[7]] = None
for r in glob:
    if r[8]:
        conds[r[8]] = None
cond_out = {}
for name in conds:
    c = J['conditions'].get(name)
    if not c:
        continue
    cond_out[name] = [c['op'], [[t[0], t[2], t[3]] for t in c['tests']], 1 if c['result'] == 'invert' else 0]

# ------------------------------------------------------------------ value lists
lists, bias = {}, {}
for name in sorted(used_lists):
    entries = V[name]['entries']
    texts = [clean(e[1]) for e in entries]
    raws = [e[0] for e in entries]
    # plain numbers: text == raw + k for every entry ('+n' allowed)
    k = None
    try:
        ks = {int(t.replace('+', '')) - r for t, r in zip(texts, raws)}
        if len(ks) == 1 and raws == sorted(raws):
            k = ks.pop()
    except ValueError:
        pass
    plus = any(t.startswith('+') for t in texts)
    if k is not None and texts == [(('+' if plus and r + k > 0 else '') + str(r + k)) for r in raws]:
        bias[name] = [k, plus, raws[0], raws[-1]]
        continue
    lists[name] = [[r, t] for r, t in zip(raws, texts)]


def js(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Access Virus TI / TI2 parameter tables from Virus Control (Software Suite 5.1.7, DLL description\n')
    f.write(f"// \"{J['name']}\" for \"{J['device']}\", version {J['version']}, {J['released']}): names, ranges, defaults,\n")
    f.write('// value texts, conditions and dump positions. Generated by tools/virus/gen_fw.py; do not edit by hand.\n\n')
    f.write(f"export const VC_VERSION = {js(J['version'] + ' (' + J['released'] + ')')};\n")
    f.write('/** Value lists: [[raw, text], ...] in display order. */\n')
    f.write('export const LISTS = {\n' + ''.join(f'  {js(k)}: {js(v)},\n' for k, v in lists.items()) + '};\n')
    f.write('/** Number lists: [k, plus sign, first raw, last raw]: the text of raw r is r + k. */\n')
    f.write(f'export const BIAS = {js(bias)};\n')
    f.write('/** Conditions: [and|or, [[parameter, min, max], ...], invert]: true when the tests hold (or fail, if invert). */\n')
    f.write('export const CONDS = {\n' + ''.join(f'  {js(k)}: {js(v)},\n' for k, v in sorted(cond_out.items())) + '};\n')
    f.write('/** Single (512 bytes: pages A, B, C, D): [offset, ...meanings [key, label, group, min, max, default, list, condition]]. */\n')
    f.write('export const SINGLE = [\n' + ''.join(f'  {js(r)},\n' for r in single_rows) + '];\n')
    f.write('/** Single bytes Virus Control does not describe. */\n')
    f.write(f'export const SINGLE_UNMAPPED = {js(unmapped)};\n')
    f.write('/** Multi (256 bytes), common values: [offset, key, label, group, min, max, default, list]. */\n')
    f.write('export const MULTI = [\n' + ''.join(f'  {js(r)},\n' for r in sorted(multi_common)) + '];\n')
    f.write('/** Multi part values (page 72 index i, part p at 32 + 16 * (i - 32) + p): [index, key, label, min, max, default, list]. */\n')
    f.write('export const MPART = [\n' + ''.join(f'  {js(r)},\n' for _, r in sorted(mpart.items())) + '];\n')
    f.write('/** Multi part switches (bits of byte 240 + part): [bit, key, label, list]. */\n')
    f.write('export const MBITS = [\n' + ''.join(f'  {js(r)},\n' for _, r in sorted(mbits.items())) + '];\n')
    f.write('/** Global (page 73): [index, key, label, group, min, max, default, list, condition]. */\n')
    f.write('export const GLOBAL = [\n' + ''.join(f'  {js(r)},\n' for r in glob) + '];\n')
    f.write('/** Page 74 (Virus Control internal): [index, key, label]. */\n')
    f.write('export const INTERN = [\n' + ''.join(f'  {js(r)},\n' for r in intern) + '];\n')
print(f'{OUT}: {len(single_rows)} single bytes ({len(unmapped)} undescribed), {len(multi_common)} multi, {len(mpart)} part, {len(mbits)} bits, {len(glob)} global, {len(lists)} lists, {len(bias)} number lists, {len(cond_out)} conditions')
