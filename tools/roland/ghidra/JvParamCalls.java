// JV-2080 v1.02: list every call of the parameter access functions with its arguments (headless or
// GUI script; copy to ~/ghidra_scripts). The flash block must be read-only so literal-pool constants
// fold. args: <out file>. Each line: call site, calling function, callee, then the arguments as
// constants (#x), literal-pool loads resolved (=x), or the decompiler's varnode.
//
// The access functions take (base, parameter ID) and look the ID up in the descriptor table at
// 0x0E058100 ([u16 mask][byte][shift][default][min][max][0]); see docs/devices/roland-jv2080.md.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.pcode.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class JvParamCalls extends GhidraScript {
  static final long[] TARGETS = {0x0e12b732L, 0x0e12b784L, 0x0e12b834L, 0x0e12b86cL, 0x0e12b894L, 0x0e12b8a4L, 0x0e12b8baL,
    0x0e12b8d6L, 0x0e12b90cL, 0x0e12b944L, 0x0e12b990L, 0x0e12b9a0L, 0x0e12ba10L, 0x0e12ba54L, 0x0e12ba8eL, 0x0e12bad0L,
    0x0e12bafcL, 0x0e12bb30L, 0x0e12bd82L, 0x0e12bdacL, 0x0e12bdecL, 0x0e12be1aL, 0x0e12be5cL, 0x0e12c14eL};

  String arg(Varnode v, int depth) throws Exception {
    if (v.isConstant()) return String.format("#%x", v.getOffset());
    if (v.isAddress()) {
      int size = v.getSize();
      long a = v.getOffset();
      if (a >= 0x0e000000L && a < 0x0e200000L) {
        long x = size == 1 ? getByte(toAddr(a)) & 0xff : size == 2 ? getShort(toAddr(a)) : getInt(toAddr(a)) & 0xffffffffL;
        return String.format("=%x", x);
      }
    }
    PcodeOp d = v.getDef();
    if (d == null || depth > 3) return v.toString();
    int oc = d.getOpcode();
    if (oc == PcodeOp.INT_SEXT || oc == PcodeOp.INT_ZEXT || oc == PcodeOp.COPY || oc == PcodeOp.CAST) return arg(d.getInput(0), depth + 1);
    StringBuilder s = new StringBuilder("<" + d.getMnemonic());
    for (int k = 0; k < d.getNumInputs(); k++) s.append(" ").append(arg(d.getInput(k), depth + 1));
    return s.append(">").toString();
  }

  public void run() throws Exception {
    String out = getScriptArgs()[0];
    ReferenceManager rm = currentProgram.getReferenceManager();
    FunctionManager fm = currentProgram.getFunctionManager();
    Map<Long, Long> site = new HashMap<>();
    Set<Function> funcs = new LinkedHashSet<>();
    PrintWriter pw = new PrintWriter(new FileWriter(out));
    for (long t : TARGETS) {
      for (Reference r : rm.getReferencesTo(toAddr(t))) {
        if (!r.getReferenceType().isCall()) continue;
        site.put(r.getFromAddress().getOffset(), t);
        Function f = fm.getFunctionContaining(r.getFromAddress());
        if (f != null) funcs.add(f);
        else pw.println(String.format("NOFUNC %08x call %08x", r.getFromAddress().getOffset(), t));
      }
    }
    DecompInterface di = new DecompInterface();
    di.openProgram(currentProgram);
    Set<Long> seen = new HashSet<>();
    for (Function f : funcs) {
      DecompileResults r = di.decompileFunction(f, 60, monitor);
      if (r == null || !r.decompileCompleted()) { pw.println("FAIL " + f.getEntryPoint()); continue; }
      Iterator<PcodeOpAST> it = r.getHighFunction().getPcodeOps();
      while (it.hasNext()) {
        PcodeOpAST op = it.next();
        if (op.getOpcode() != PcodeOp.CALL && op.getOpcode() != PcodeOp.CALLIND) continue;
        long at = op.getSeqnum().getTarget().getOffset();
        Long ta = site.get(at);
        if (ta == null) continue;
        seen.add(at);
        StringBuilder sb = new StringBuilder(String.format("%08x %s call %08x", at, f.getEntryPoint(), ta));
        for (int i = 1; i < op.getNumInputs(); i++) sb.append(" a").append(i).append("=").append(arg(op.getInput(i), 0));
        pw.println(sb);
      }
    }
    for (Map.Entry<Long, Long> e : site.entrySet()) if (!seen.contains(e.getKey())) pw.println(String.format("MISS %08x call %08x", e.getKey(), e.getValue()));
    pw.close();
    println("sites " + site.size() + " funcs " + funcs.size());
  }
}
