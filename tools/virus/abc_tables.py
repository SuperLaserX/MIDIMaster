# Tables of a Virus A / B / C host OS for MIDIMaster, read from the OS itself (tools/virus/abc_host.py runs its menu
# and knob display code in the 8051 emulator): every edit-menu parameter with its screen label, range and the text
# its screen shows for each value, the panel knobs, the page A controller names and which page A / B / C index the
# parameter reader takes from the sound, the multi, the global settings or the DSP.
#
#   python -I tools/virus/abc_tables.py extract <os> <image> <raw.json>    (minutes: emulates every menu value)
#   python -I tools/virus/abc_tables.py js <os> <image> <raw.json> <out.js>
#
# <os>: b49 (Virus B / kb / Indigo, OS 4.9) or classic (Virus Classic OS 4.9); <image> the OS image decoded from the
# update's first MIDI file (re/virus/old/osupd.py) or the flash dump. Firmware is untrusted data: run with python -I.
import sys, os, json, re, importlib.util

_s = importlib.util.spec_from_file_location('abc_host', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'abc_host.py'))
H = importlib.util.module_from_spec(_s); _s.loader.exec_module(H)


def extract(osname, image, raw):
    A = H.OSES[osname]
    img = open(image, 'rb').read()
    out = dict(os=A['name'], menus=H.extract_menus(img, A), knobs=H.extract_knobs(img, A), cc=H.cc_names(img, A),
               classes={f'{p}:{i}': c for (p, i), c in H.handler_classes(img, A).items()})
    json.dump(out, open(raw, 'w'), indent=0)


# ------------------------------------------------------------------ JS tables
NUM = re.compile(r'^[+-]?\d+(\.\d+)?%?$')


def js(osname, image, raw, out_js):
    A = H.OSES[osname]
    R = json.load(open(raw))
    lists, list_at = [], {}

    def list_id(texts):
        k = json.dumps(texts)
        if k not in list_at: list_at[k] = len(lists); lists.append(texts)
        return list_at[k]

    def clean(t): return re.sub(r' +', ' ', t).strip()

    img = open(image, 'rb').read()
    if A.get('title_count'):
        # (the A's titles from 80h on are its bank / program screens) the C's title printer (0507) prints title 0 for numbers past its table (63h; layouts with bit 7 titles print
        # the bank / program themselves), the label printer (0551) none for label 0 and label 0 past C0h
        for t in R['menus']:
            for r in t['records']:
                rb = bytes.fromhex(r['raw'])
                F = A.get('fields', H.FIELDS)
                ti, la = rb[F['title']], rb[F['label']]
                if ti >= A['title_count']: r['title'] = H.text16(img, A['titles'])
                r['label'] = '' if la == 0 else H.text16(img, A['labels'] + 16 * (la if la < A['label_count'] else 0))

    # parameter -> the menu records that edit it (single mode table first)
    by = {}
    for mi, t in enumerate(R['menus']):
        for r in t['records']:
            if r['page'] > 2 or r['index'] > 127 or 'texts' not in r or r['dtype'] == 0xff: continue
            by.setdefault((r['page'], r['index']), []).append((mi, r))
    params = {}
    # the reader's handler classes from the image with the current config (so a config change needs no new extract)
    cls = {f'{p}:{i}': c for (p, i), c in H.handler_classes(img, A).items()}
    rng = lambda key, r: A.get('ranges', {}).get(key, (r['min'], r['max']))
    for key, rs in by.items():
        # records whose display shows the value (some multi-mode records show the part instead: all values alike)
        good = [(mi, r) for mi, r in rs if not any(str(v).startswith('!') for v in r['texts'].values())
                and (len({r['texts'][str(v)] for v in range(rng(key, r)[0], rng(key, r)[1] + 1)}) > 1 or r['min'] == r['max'])]
        if not good: continue
        # a record with a title of its own first (multi-mode part records have title 0, "Error at D16O": the screen
        # prints the part there instead)
        # print the part there instead), then the widest range (the multi part bank: A-D in one record, A-H in another)
        # a part row (the reader takes it from the part): the multi's part records first (the Rack XL's RANDOM menu shows
        # page C 43, the part's pan, as ParaDepth)
        part = cls.get(f'{key[0]}:{key[1]}') == 'part' and any(x['title'].startswith('Error') for _, x in good) and len({x['label'] for _, x in good}) > 1
        good.sort(key=lambda x: (part and not x[1]['title'].startswith('Error'), x[1]['title'].startswith('Error') and not part, -(rng(key, x[1])[1] - rng(key, x[1])[0]), x[0]))
        mi, r = good[0]
        names = []
        for _, x in good:
            # title 0 / label 0 are the OS's "Error at D16O" / "Error at D16U" placeholders: such a record prints no text
            n = clean(x['label'] or ('' if x['title'].startswith('Error') else x['title'].title())) or f'Unlabelled (page {"ABC"[key[0]]} {key[1]})'
            # layout 5 (the multi mode part records) prints the part's bank and program in place of a title
            g = '' if x['title'].startswith('Error') or x['layout'] == 5 else clean(x['title'])
            if (g, n) not in names: names.append((g, n))
        lo, hi = rng(key, r)
        texts = [clean(r['texts'][str(v)]) for v in range(lo, hi + 1)]
        params[key] = dict(group=names[0][0], label=names[0][1], more=[f'{g} / {n}' for g, n in names[1:]], min=lo, max=hi,
                           list=list_id(texts), modes=sorted({R['menus'][m]['model'] for m, _ in good}), dtype=r['dtype'],
                           init=r['d'] if r['min'] <= r['d'] <= r['max'] else None)
    # parameters a menu sets by its record (the C's LFO 3 destination: the record of edit mode 2 shown is page B 11's value)
    # labels the records do not give (the C's LFO 3 amount: each of its records is labelled with a destination)
    for key, lab in A.get('label_fix', {}).items():
        if key in params: params[key]['label'] = lab
    for key, sp in A.get('synth', {}).items():
        tab = next(t for t in R['menus'] if t['table'] == sp['table'])
        by_id = {bytes.fromhex(r['raw'])[0]: r['label'] for r in tab['records']}
        texts = [clean(by_id.get(img[sp['ids'] + v], f'record {v}')) for v in range(sp['n'])]
        params[key] = dict(group=sp['title'], label=sp['label'], more=[], min=0, max=sp['n'] - 1, list=list_id(texts), modes=[tab['model']], dtype=0, init=0)
    # knob-only parameters: the knob's screen name and the knob display's value texts (the C has no knob texts: its
    # knobs are named by their first page A parameter's controller name, a knob-only parameter by its short name)
    def knob_text(k):
        if k['text']: return re.sub(r'^\d+:\s*', '', k['text'])
        if A.get('knob_names'): return A['knob_names'][k['knob']]
        a = [t for t in k['targets'] if t['page'] == 0]
        return R['cc'].get(str(a[0]['index'])) or a[0]['name'] if a else (k['targets'][0]['name'] if k['targets'] else f'Knob {k["knob"]}')
    knobs = []
    for k in R['knobs']:
        tg = []
        for t in k['targets']:
            if t['page'] > 1: continue
            tg.append([t['name'], 128 * t['page'] + t['index']])
            key = (t['page'], t['index'])
            if key not in params:
                texts = [clean(t['texts'][str(v)]) for v in range(128)]
                # a knob whose display stops changing (the C's Osc 3 mode at 67 = wave 64, distortion type at 11): the
                # range ends where the texts do
                hi = max([v for v in range(1, 128) if texts[v] != texts[v - 1]], default=127)
                if A.get('trim_knobs') and hi < 127 and len(set(texts[hi:])) == 1: texts = texts[:hi + 1]
                else: hi = 127
                g = A.get('knob_groups', {}).get(key) or t.get('title') or None
                params[key] = dict(group=f'Panel knobs: {g}' if g else 'Panel knobs', label=knob_text(k) if k['text'] else t['name'],
                                   more=[], min=0, max=hi, list=list_id(texts), modes=[], dtype=t['dtype'], knob=k['knob'])
            elif t['name'] not in params[key].get('knobNames', []):
                params[key].setdefault('knobNames', []).append(t['name'])
        knobs.append([k['knob'], knob_text(k), tg])
    # parameters whose only menu reinterprets them (the Rack XL's vocoder page): named by the knob that edits them
    for k in R['knobs']:
        for t in k['targets']:
            key = (t['page'], t['index'])
            p = params.get(key)
            if p and t.get('title') and p['group'] in A.get('knob_over_titles', []) and not p.get('renamed'):
                p['more'].insert(0, f"{p['group']} / {p['label']}")
                p['group'], p['label'], p['renamed'] = t['title'], t['name'], True
    for key, p in params.items():
        for k in R['knobs']:
            for t in k['targets']:
                if (t['page'], t['index']) == key and t['name'] not in p.setdefault('knobNames', []): p['knobNames'].append(t['name'])
    rows = lambda page: [[i, p['label'], p['group'], p['min'], p['max'], p['list'], p.get('knobNames', []), p['more'], p['modes'], p.get('init')]
                         for (pg, i), p in sorted(params.items()) if pg == page]
    with open(out_js, 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'// Generated by tools/virus/abc_tables.py from the {R["os"]} host image: do not edit by hand.\n')
        f.write('// Each parameter: [index, screen label, menu title, min, max, value list, knob names, other menus, play modes\n')
        f.write('// whose menus show it, the menu record\'s reset value]; value list n = LISTS[n], the screen texts of min..max.\n')
        f.write('// Page A / B are the single\'s\n')
        f.write('// bytes 0-127 / 128-255, page C the multi and the global settings (CLASS tells which).\n')
        f.write(f'export const OS = {json.dumps(R["os"])};\n')
        f.write(f'export const MODES = {json.dumps([t["model"] for t in R["menus"]])};\n')
        f.write('export const LISTS = [\n' + ''.join(f'  {json.dumps(l, ensure_ascii=False)},\n' for l in lists) + '];\n')
        for name, page in (('PAGE_A', 0), ('PAGE_B', 1), ('PAGE_C', 2)):
            f.write(f'export const {name} = [\n' + ''.join(f'  {json.dumps(r, ensure_ascii=False)},\n' for r in rows(page)) + '];\n')
        f.write(f'export const CC_NAMES = {json.dumps({int(k): v for k, v in R["cc"].items()})};\n')
        f.write('/** Panel knobs: [knob, screen text, [[short name, single offset] for each panel state]] */\n')
        f.write('export const KNOBS = [\n' + ''.join(f'  {json.dumps(k, ensure_ascii=False)},\n' for k in knobs) + '];\n')
        f.write('/** Where the parameter reader takes each page A / B / C index from (its handler table): single (the sound), controller\n')
        f.write(' * (performance controllers, not in the sound), panel (panel selections), dsp (asked from the DSP), multi, global, or the handler address. */\n')
        f.write('export const CLASS = ' + json.dumps({f'{"ABC"[int(k.split(":")[0])]}{k.split(":")[1]}': v for k, v in cls.items()}) + ';\n')
    print('wrote', out_js, len(lists), 'lists', {n: len(rows(p)) for n, p in (('A', 0), ('B', 1), ('C', 2))})


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'extract': extract(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'js': js(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
