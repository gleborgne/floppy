import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentCommand } from "../src/command.ts";

describe("lanceur d'agent", () => {
  it("un shim npm devient node + script, sans interpréter les arguments dans un shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-shim-"));
    const script = join(dir, "node_modules", "agent", "cli.mjs");
    mkdirSync(join(dir, "node_modules", "agent"), { recursive: true });
    writeFileSync(script, "");
    const shim = join(dir, "agent.cmd");
    writeFileSync(shim, '"%_prog%" "%dp0%\\node_modules\\agent\\cli.mjs" %*');
    const result = agentCommand(shim, ["--model", "provider/model", "texte ; & $(commande)"]);
    expect(result.command).not.toMatch(/cmd\.exe$/i);
    expect(result.args).toEqual([script, "--model", "provider/model", "texte ; & $(commande)"]);
  });

  it("un script de shell arbitraire est refusé", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bad-shim-")); const script = join(dir, "agent.cmd");
    writeFileSync(script, "echo commande arbitraire");
    expect(() => agentCommand(script, [])).toThrow();
    expect(agentCommand("agent.exe", ["x"])).toEqual({ command: "agent.exe", args: ["x"] });
  });
});
