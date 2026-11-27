#!/usr/bin/env python3
"""Read-only address map scan of the SYSTEM-8 CTRL port (RQ1, size 16).
Pipelined: a batch of probes is sent, then all replies are collected and
attributed by the address they carry. usage: python -I scan_map.py OUT.json"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import S8, rq1, parse_dt1, a28

out = sys.argv[1]
s = S8(listen=('SYSTEM-8 CTRL',)); s.drain(0.3)
hits = {}
def collect(wait):
    for n, b in s.drain(wait, 0.3):
        p = parse_dt1(b)
        if p:
            hits.setdefault('%02X %02X %02X %02X' % tuple(a28(p[0])), len(p[1]))
t = time.time()
for b0 in range(0x00, 0x70):
    for b1 in range(128):
        s.send(rq1(b0 << 21 | b1 << 14, 16))
        time.sleep(0.003)
    collect(0.6)
    print('%02X' % b0, sum(1 for k in hits if k.startswith('%02X ' % b0)), flush=True)
collect(1.0)
json.dump(dict(sorted(hits.items())), open(out, 'w'), indent=0)
print('done', len(hits), time.time() - t)
s.close()
