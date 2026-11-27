#!/usr/bin/env python3
"""Phase 1 port probe: Identity Request and the PLUG-OUT info queries on each port.
Read-only (queries only). usage: python -I probe_ports.py"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mido
from s8midi import S8, find_port, dt1, rq1, hexs

ident = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]
for outname in ('SYSTEM-8', 'SYSTEM-8 CTRL'):
    s = S8(out=outname)
    s.drain(0.3)
    print(f'--- out={outname}: Identity Request')
    s.send(ident)
    for n, b in s.drain(1.0):
        print(f'   in {n}: {hexs(b)}')
    print(f'--- out={outname}: query 70 00 02 00 (device type)')
    s.send(dt1(0x0E000100, [0]))   # 70 00 02 00 = 0x0E000100
    for n, b in s.drain(1.5):
        print(f'   in {n}: {hexs(b)}')
    s.close()
    time.sleep(0.3)
