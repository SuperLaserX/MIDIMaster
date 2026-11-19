# Minimal 68000 harness around the K2000 OS image: calls firmware routines
# (parameter display/format functions) under Unicorn and returns their output.
#
# The OS normally builds its object directory in RAM at boot. Here RAM starts
# zeroed, so the object lookup routines are answered from the ROM object area
# (the same Kurzweil object blocks the OS copies at boot).
import struct
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UcError, UC_HOOK_CODE
from unicorn.m68k_const import UC_M68K_REG_PC, UC_M68K_REG_A7, UC_M68K_REG_A5, UC_M68K_REG_D0, UC_CPU_M68K_M68020

ROM_BASE = 0x100000
STOP = 0x0FFF00          # return address that ends a call
STACK_TOP = 0x0F0000
A5_BASE = 0x020000
BUF = 0x0E0000

OBJ_FIND = 0x1032EA      # find object by (type << 16 | id), returns handle or 0
OBJ_HANDLE = 0x103310    # same lookup, returns handle
OBJ_DEREF = 0x10B90A     # handle -> data pointer


def scan_objects(d):
    """Walk the ROM object area and index objects by (type, id)."""
    u16 = lambda a: struct.unpack('>H', d[a:a + 2])[0]
    s32 = lambda a: struct.unpack('>i', d[a:a + 4])[0]
    start = None
    for p in range(0, len(d) - 32, 2):
        bs = s32(p)
        if -0x20000 < bs < -8 and u16(p + 4) == 0x6200 and d[p + 10:p + 28] == b'CHH Initialization':
            start = p
            break
    objs = {}
    p = start
    while p is not None and p + 4 <= len(d):
        bs = s32(p)
        if bs >= 0 or bs < -0x100000:
            break
        end = p - bs
        o = p + 4
        while o + 6 <= end:
            h, sz, no = u16(o), u16(o + 2), u16(o + 4)
            if not sz:
                break
            name = d[o + 6:d.index(b'\0', o + 6)].decode('latin1')
            if h & 0x8000:
                typ, oid = (h >> 10) + 96, h & 1023
            else:
                typ, oid = h >> 8, h & 255
            objs.setdefault((typ, oid), {
                'type': typ, 'id': oid, 'name': name,
                'addr': ROM_BASE + o + 4 + no, 'size': sz - no, 'entry': ROM_BASE + o,
            })
            o += sz + (sz & 1)
        p = end
    return objs


class Firmware:
    def __init__(self, path):
        self.rom = open(path, 'rb').read()
        self.objects = scan_objects(self.rom)
        self.uc = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
        try:
            self.uc.ctl_set_cpu_model(UC_CPU_M68K_M68020)
        except Exception:
            pass
        uc = self.uc
        uc.mem_map(0, 0x100000)                       # RAM (globals, stack, scratch)
        uc.mem_map(ROM_BASE, 0x100000)                # OS ROM
        uc.mem_write(ROM_BASE, self.rom)
        uc.mem_map(0x200000, 0x600000)                # setup ROM / DSP / I/O: zero-filled
        uc.mem_write(STOP, bytes.fromhex('4e71' * 8))
        self.ram0 = bytes(0x100000)
        for addr, fn in ((OBJ_FIND, self._find_object), (OBJ_HANDLE, self._find_object), (OBJ_DEREF, self._deref)):
            uc.hook_add(UC_HOOK_CODE, fn, begin=addr, end=addr)

    # ---------------------------------------------------------- hooks
    def _arg(self, n=0):
        sp = self.uc.reg_read(UC_M68K_REG_A7)
        return struct.unpack('>I', bytes(self.uc.mem_read(sp + 4 + 4 * n, 4)))[0]

    def _ret(self, value):
        uc = self.uc
        sp = uc.reg_read(UC_M68K_REG_A7)
        ret = struct.unpack('>I', bytes(uc.mem_read(sp, 4)))[0]
        uc.reg_write(UC_M68K_REG_D0, value & 0xffffffff)
        uc.reg_write(UC_M68K_REG_A7, sp + 4)
        uc.reg_write(UC_M68K_REG_PC, ret)

    def _find_object(self, uc, addr, size, ud):
        key = self._arg(0)
        obj = self.objects.get(((key >> 16) & 0xffff, key & 0xffff))
        self._ret(obj['addr'] if obj else 0)

    def _deref(self, uc, addr, size, ud):
        h = self._arg(0)
        self._ret(h if h >= ROM_BASE else 0)

    # ---------------------------------------------------------- helpers
    def u16(self, a):
        return struct.unpack('>H', self.rom[a - ROM_BASE:a - ROM_BASE + 2])[0]

    def call(self, addr, longs=(), words_first=(), limit=400000):
        uc = self.uc
        sp = STACK_TOP
        args = b''.join(struct.pack('>H', w & 0xffff) for w in words_first) + b''.join(struct.pack('>I', v & 0xffffffff) for v in longs)
        sp -= len(args)
        uc.mem_write(sp, args)
        sp -= 4
        uc.mem_write(sp, struct.pack('>I', STOP))
        uc.reg_write(UC_M68K_REG_A7, sp)
        uc.reg_write(UC_M68K_REG_A5, A5_BASE)
        try:
            uc.emu_start(addr, STOP, count=limit)
        except UcError as e:
            return None, str(e)
        if uc.reg_read(UC_M68K_REG_PC) != STOP:
            return None, 'limit'
        return uc.reg_read(UC_M68K_REG_D0), None

    def reset_ram(self):
        self.uc.mem_write(0, self.ram0)

    def cstr(self, a, n=64):
        b = bytes(self.uc.mem_read(a, n))
        return b.split(b'\0', 1)[0].decode('latin1')

    def display(self, disp_idx, fmt_addr, value, desc_addr):
        """Run display function `disp_idx` (index into the table at 0x186D06) via the dispatcher."""
        self.uc.mem_write(BUF, bytes(64))
        r, err = self.call(0x15E690, longs=(BUF, fmt_addr, value, desc_addr), words_first=(disp_idx,))
        if err:
            return None, err
        return self.cstr(BUF), None

    def sprintf(self, fmt_addr, value):
        self.uc.mem_write(BUF, bytes(64))
        r, err = self.call(0x10966E, longs=(BUF, fmt_addr, value))
        if err:
            return None, err
        return self.cstr(BUF), None
