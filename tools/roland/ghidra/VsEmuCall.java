// Call a firmware function in Ghidra's p-code emulator, then dump memory regions (headless helper).
// args: <out prefix> <function hex> <r4 hex> <r5 hex> <r6 hex> <r7 hex> [pre:<start hex>:<stop hex>]... <addr:len>...
// pre: first run the code from start until it reaches stop (e.g. the start-up code that copies the
// initialized data into RAM). Writes <out prefix>.<addr>.bin for each region and prints how it ended.
import ghidra.app.emulator.EmulatorHelper;
import ghidra.app.script.GhidraScript;
import ghidra.pcode.memstate.MemoryFaultHandler;
import ghidra.program.model.address.*;
import java.io.*;
import java.math.BigInteger;

public class VsEmuCall extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        String prefix = a[0];
        Address fn = toAddr(Long.parseUnsignedLong(a[1], 16));
        Address ret = toAddr(0x8C7FFF00L);
        EmulatorHelper emu = new EmulatorHelper(currentProgram);
        emu.setMemoryFaultHandler(new MemoryFaultHandler() {
            public boolean uninitializedRead(Address address, int size, byte[] buf, int bufOffset) { return true; }
            public boolean unknownAddress(Address address, boolean write) { return false; }
        });
        for (int i = 6; i < a.length; i++) {
            if (!a[i].startsWith("pre:")) continue;
            String[] p = a[i].split(":");
            Address start = toAddr(Long.parseUnsignedLong(p[1], 16)), stop = toAddr(Long.parseUnsignedLong(p[2], 16));
            emu.writeRegister("r15", BigInteger.valueOf(0x8C7F0000L));
            emu.writeRegister(emu.getPCRegister(), BigInteger.valueOf(start.getOffset()));
            long n = 0;
            while (!emu.getExecutionAddress().equals(stop) && n++ < 200000000L && !monitor.isCancelled()) {
                if (!emu.step(monitor)) { println("pre fault at " + emu.getExecutionAddress() + ": " + emu.getLastError()); break; }
            }
            println("pre " + p[1] + "-" + p[2] + ": " + n + " steps");
        }
        emu.writeRegister("r15", BigInteger.valueOf(0x8C7F0000L));
        String[] regs = { "r4", "r5", "r6", "r7" };
        for (int i = 0; i < 4; i++) emu.writeRegister(regs[i], new BigInteger(a[2 + i], 16));
        emu.writeRegister("PR", BigInteger.valueOf(ret.getOffset()));
        emu.writeRegister("FPSCR", BigInteger.valueOf(0x00040001L));
        emu.writeRegister(emu.getPCRegister(), BigInteger.valueOf(fn.getOffset()));
        long steps = 0;
        String end = "returned";
        while (!monitor.isCancelled()) {
            Address pc = emu.getExecutionAddress();
            if (pc.equals(ret)) break;
            if (pc.getOffset() < 0x89300000L || ++steps > 50000000L) { end = "stopped at " + pc + " after " + steps + " steps"; break; }
            if (!emu.step(monitor)) { end = "fault at " + pc + ": " + emu.getLastError(); break; }
        }
        println("call " + a[1] + ": " + end + " (" + steps + " steps), r0=" + emu.readRegister("r0").toString(16));
        for (int i = 6; i < a.length; i++) {
            if (a[i].startsWith("pre:")) continue;
            String[] p = a[i].split(":");
            long addr = Long.parseUnsignedLong(p[0], 16);
            int len = Integer.parseInt(p[1], 16);
            byte[] data = emu.readMemory(toAddr(addr), len);
            try (FileOutputStream f = new FileOutputStream(prefix + "." + p[0] + ".bin")) { f.write(data); }
        }
        emu.dispose();
    }
}
