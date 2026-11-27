"""Extract the Virus TI parameter description that Virus Control carries inside its plug-in DLL.

Virus Control (the Virus TI's editor plug-in, Software Suite 5.1.7) embeds XML documents in its
DLL; one <Remotedevice device="Virus TI Desktop/Polar/Keyboard"> describes every parameter of the
synth: ParameterSets (name, range, default, value list, the MIDI message and controller index that
edits it, visibility/active conditions), Valuelists (the display text of every value), Conditionsets
and MIDIMessages (the parameter pages 6E/6F/70-74 and the single/multi dump layouts).

usage:
  python -I vc_xml.py [DLL] [OUT.json] [DEVICE]
  (the Snow: python -I vc_xml.py z:/firmwares/VirusTI2/viruscontrol_dll64 re/virus/snow/snow.json "Virus TI Snow")
  defaults: z:/firmwares/VirusTI2/viruscontrol_dll64 -> re/virusti/vc/ti.json

The DLL is only read as bytes (never loaded or run).
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

DLL = sys.argv[1] if len(sys.argv) > 1 else 'z:/firmwares/VirusTI2/viruscontrol_dll64'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'z:/MIDIMaster/re/virusti/vc/ti.json'
DEVICE = sys.argv[3] if len(sys.argv) > 3 else 'Virus TI Desktop/Polar/Keyboard'  # or 'Virus TI Snow'


def find_xml(blob, device):
    for m in re.finditer(rb'<\?xml version=', blob):
        root = re.compile(rb'<([A-Za-z_][\w\-]*)[\s>]').search(blob, m.start() + 5)
        if not root or root.group(1) != b'Remotedevice':
            continue
        end = blob.find(b'</Remotedevice>', root.start())
        doc = blob[m.start():end + len(b'</Remotedevice>')]
        head = doc[:400].decode('latin1')
        if f'device="{device}"' in head:
            return doc
    raise SystemExit(f'no Remotedevice for {device!r} in {DLL}')


def num(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def main():
    blob = open(DLL, 'rb').read()
    doc = find_xml(blob, DEVICE)
    root = ET.fromstring(doc)
    out = {'device': root.get('device'), 'name': root.get('name'), 'version': root.get('version'), 'released': root.get('releasedate')}

    params = {}
    sets = []
    for s in root.find('ParameterSets'):
        sets.append(s.get('name'))
        for p in s:
            full = f"{s.get('name')}/{p.get('name')}"
            params[full] = {
                'set': s.get('name'), 'name': p.get('name'), 'display': p.get('displayname'), 'short': p.get('shortname'),
                'min': num(p.get('minValue')), 'max': num(p.get('maxValue')), 'def': num(p.get('defaultValue')),
                'vl': p.get('valuelist'), 'cond': p.get('condition'), 'msg': p.get('defaultmessage'),
                'ci': num(p.get('controllerindex')), 'part': p.get('part'),
                'auto': p.get('automatable') == 'true', 'perf': p.get('performanceCtrl') == 'true',
            }
    out['sets'] = sets
    out['params'] = params

    vls = {}
    for v in root.find('Valuelists'):
        entries = []
        for e in v:
            idx = num(e.get('index'))
            raw = num(e.get('value'), idx)
            entries.append([raw, (e.text or ''), idx])
        vls[v.get('name')] = {'type': v.get('type'), 'entries': entries}
    out['valuelists'] = vls

    conds = {}
    for c in root.find('Conditionsets'):
        conds[c.get('name')] = {'op': c.get('operand'), 'result': c.get('result'),
                                'tests': [[t.get('param'), t.get('type'), num(t.get('minvalue')), num(t.get('maxvalue'))] for t in c]}
    out['conditions'] = conds

    msgs = {}
    for m in root.find('MIDIMessages'):
        bytes_ = []
        for b in m:
            entry = {k: b.get(k) for k in b.keys()}
            kids = [{k: x.get(k) for k in x.keys()} for x in b]
            if kids:
                entry['map'] = kids
            bytes_.append(entry)
        msgs[m.get('id')] = bytes_
    out['messages'] = msgs

    sk = root.find('SoftknobMapping')
    if sk is not None:
        out['softknob'] = [[num(x.get('index')), x.get('parameter')] for x in sk]
    init = root.find('Initialisation')
    if init is not None:
        out['init'] = [{k: x.get(k) for k in x.keys()} | {'tag': x.tag} for x in init]

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f'{OUT}: {len(params)} parameters, {len(vls)} value lists, {len(conds)} conditions, {len(msgs)} messages ({out["version"]})')


if __name__ == '__main__':
    main()
