// Disassemble a range of the JV-2080 flash (SH-2) and print it with literal-pool values resolved
// (copy to ~/ghidra_scripts). args: <start hex> <instruction count>. Disassembles where needed.
import ghidra.app.script.GhidraScript;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;

public class JvDis extends GhidraScript {
  public void run() throws Exception {
    String[] a = getScriptArgs();
    Address cur = toAddr(Long.parseLong(a[0], 16));
    int n = Integer.parseInt(a[1]);
    Listing l = currentProgram.getListing();
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < n; i++) {
      Instruction ins = l.getInstructionAt(cur);
      if (ins == null && l.getDefinedDataAt(cur) == null) {
        new DisassembleCommand(cur, new AddressSet(cur, cur.add(1)), false).applyTo(currentProgram);
        ins = l.getInstructionAt(cur);
      }
      if (ins == null) { sb.append(cur + String.format("  .word %04x\n", getShort(cur) & 0xffff)); cur = cur.add(2); continue; }
      String extra = "";
      for (int op = 0; op < ins.getNumOperands(); op++) for (Object o : ins.getOpObjects(op)) if (o instanceof Address) {
        Address ad = (Address) o; String m = ins.getMnemonicString();
        try {
          if (m.startsWith("mov.l")) extra += String.format(" [=%08x]", getInt(ad));
          else if (m.startsWith("mov.w")) extra += String.format(" [=%04x]", getShort(ad) & 0xffff);
        } catch (Exception e) { }
      }
      sb.append(cur + "  " + ins + extra + "\n");
      cur = cur.add(ins.getLength());
    }
    println(sb.toString());
  }
}
