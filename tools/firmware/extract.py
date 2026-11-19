"""Unpack every firmware archive into re/firmware/<archive name>/ with 7-Zip.

Nested archives (a zip inside a zip) are unpacked in place, two levels deep.
Writes re/firmware/manifest.json listing every extracted file with its size and
SHA-1. Extracted files are data only: nothing here runs them.

Usage: python -I tools/firmware/extract.py Z:/firmwares re/firmware
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

SEVEN_ZIP = r'C:\Program Files\7-Zip\7z.exe'
ARCHIVE = re.compile(r'\.(zip|rar|7z)$', re.I)


def safe_name(name):
    stem = ARCHIVE.sub('', name)
    stem = re.sub(r'[<>:"|?*\x00-\x1f]', '_', stem).strip(' .')
    return stem or 'archive'


def unpack(archive, dest):
    os.makedirs(dest, exist_ok=True)
    r = subprocess.run([SEVEN_ZIP, 'x', '-y', '-bd', '-bso0', '-bsp0', f'-o{dest}', archive],
                       capture_output=True, text=True, errors='replace')
    return r.returncode, r.stderr.strip()[-400:]


def sha1(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main(src, out):
    os.makedirs(out, exist_ok=True)
    manifest = []
    names = sorted(os.listdir(src))
    for i, name in enumerate(names):
        path = os.path.join(src, name)
        if os.path.isdir(path) or not ARCHIVE.search(name):
            manifest.append({'source': name, 'kind': 'folder' if os.path.isdir(path) else 'file', 'files': []})
            continue
        dest = os.path.join(out, safe_name(name))
        if os.path.isdir(dest) and os.listdir(dest):
            status, err = 0, ''
        else:
            status, err = unpack(path, dest)
        # Unpack nested archives, two levels deep.
        for _ in range(2):
            nested = []
            for root, _dirs, files in os.walk(dest):
                for f in files:
                    if ARCHIVE.search(f):
                        nested.append(os.path.join(root, f))
            if not nested:
                break
            for n in nested:
                ndest = os.path.join(os.path.dirname(n), safe_name(os.path.basename(n)) + '__x')
                if os.path.isdir(ndest):
                    continue
                code, nerr = unpack(n, ndest)
                if code == 0:
                    os.remove(n)
                else:
                    shutil.rmtree(ndest, ignore_errors=True)
                    err = (err + ' | nested ' + os.path.basename(n) + ': ' + nerr)[-400:]
        files = []
        for root, _dirs, fs in os.walk(dest):
            for f in fs:
                p = os.path.join(root, f)
                files.append({'path': os.path.relpath(p, out).replace('\\', '/'), 'size': os.path.getsize(p), 'sha1': sha1(p)})
        manifest.append({'source': name, 'kind': 'archive', 'dir': os.path.relpath(dest, out).replace('\\', '/'),
                         'status': status, 'error': err, 'files': files})
        if i % 50 == 0:
            print(f'{i}/{len(names)} {name}', flush=True)
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    bad = [m for m in manifest if m.get('status')]
    print(f'done: {len(manifest)} entries, {sum(len(m["files"]) for m in manifest)} files, {len(bad)} with errors')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
