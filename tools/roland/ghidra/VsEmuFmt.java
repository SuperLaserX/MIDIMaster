// Run the V-Synth's parameter display routine (FUN_89461a70: r4 = parameter id, r5 = value,
// r6 = 1 to add the unit) in Ghidra's p-code emulator and print the text it returns.
// args: <out file> <jobs file> [fpscr hex] [function hex]
// jobs file: lines "id min max" (decimal); every value min..max is formatted without and with unit.
// Output lines: "id<TAB>value<TAB>text<TAB>text with unit", or "id<TAB>value<TAB>!error".
import ghidra.app.emulator.EmulatorHelper;
import ghidra.app.script.GhidraScript;
import ghidra.pcode.memstate.MemoryFaultHandler;
import ghidra.program.model.address.*;
import java.io.*;
import java.math.BigInteger;
import java.nio.file.*;
import java.util.*;

public class VsEmuFmt extends GhidraScript {
    EmulatorHelper emu;
    Address ret;
    long fpscr;
    Address fn;

    String call(int id, int value, int unit) throws Exception {
        emu.writeRegister("r15", BigInteger.valueOf(0x8C7F0000L));
        emu.writeRegister("r4", BigInteger.valueOf(id & 0xffffffffL));
        emu.writeRegister("r5", BigInteger.valueOf(value & 0xffffffffL));
        emu.writeRegister("r6", BigInteger.valueOf(unit));
        emu.writeRegister("r7", BigInteger.ZERO);
        emu.writeRegister("PR", BigInteger.valueOf(ret.getOffset()));
        emu.writeRegister("FPSCR", BigInteger.valueOf(fpscr));
        emu.writeRegister(emu.getPCRegister(), BigInteger.valueOf(fn.getOffset()));
        int steps = 0;
        while (!monitor.isCancelled()) {
            Address pc = emu.getExecutionAddress();
            if (pc.equals(ret)) break;
            if (pc.getOffset() < 0x89300000L || ++steps > 200000) {
                return "!stopped at " + pc + " after " + steps + " steps";
            }
            if (!emu.step(monitor)) return "!fault at " + pc + ": " + emu.getLastError();
        }
        long r0 = emu.readRegister("r0").longValue() & 0xffffffffL;
        if (r0 == 0) return "!null";
        byte[] s = emu.readMemory(toAddr(r0), 64);
        StringBuilder sb = new StringBuilder();
        for (byte c : s) {
            if (c == 0) break;
            int u = c & 0xff;
            sb.append(u >= 0x20 && u < 0x7f ? String.valueOf((char) u) : String.format("\\x%02x", u));
        }
        return sb.toString();
    }

    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        fpscr = a.length > 2 ? Long.parseLong(a[2], 16) : 0x00040001L;
        fn = toAddr(a.length > 3 ? Long.parseUnsignedLong(a[3], 16) : 0x89461a70L);
        ret = toAddr(0x8C7FFF00L);
        emu = new EmulatorHelper(currentProgram);
        emu.setMemoryFaultHandler(new MemoryFaultHandler() {
            public boolean uninitializedRead(Address address, int size, byte[] buf, int bufOffset) {
                return true; // RAM starts as zeros
            }
            public boolean unknownAddress(Address address, boolean write) {
                return false;
            }
        });
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        for (String line : Files.readAllLines(Paths.get(a[1]))) {
            String[] f = line.trim().split("\\s+");
            if (f.length < 3) continue;
            int id = Integer.parseInt(f[0]), mn = Integer.parseInt(f[1]), mx = Integer.parseInt(f[2]);
            for (int v = mn; v <= mx; v++) {
                String t0 = call(id, v, 0);
                String t1 = t0.startsWith("!") ? "" : call(id, v, 1);
                out.println(id + "\t" + v + "\t" + t0 + "\t" + t1);
            }
            out.flush();
        }
        out.close();
        emu.dispose();
    }
}
