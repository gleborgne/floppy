import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, MemoryAudit, MemorySecrets, definePlugin } from "@floppy/core";
import type { BrainService, LlmService, AgentService, BrainEvent } from "@floppy/contracts";
import { createExternalAgent, borrowAgent, validAgentModel } from "../src/index.ts";
import { floppyToolName, openCodeSystemConfigPaths, type AgentProtocol } from "../src/profiles.ts";

const fixture = fileURLToPath(new URL("./fixtures/external-agent.mjs", import.meta.url));
const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function boot(protocol: AgentProtocol, timeout_s = 5) {
  const home = mkdtempSync(join(tmpdir(), "floppy-agent-"));
  const audit = new MemoryAudit(); const secrets = new MemorySecrets();
  const scopes: { tools: string[]; closed: boolean }[] = [];
  const mcp = definePlugin({ manifest: { id: "test-mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
    ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "FULL-TOKEN", scoped(opts) {
      const s = { tools: opts.tools, closed: false }; scopes.push(s);
      return { url: "http://127.0.0.1:1/mcp", token: "SCOPE-TOKEN", close() { s.closed = true; } };
    } });
  } });
  const plugin = createExternalAgent({ id: protocol, label: protocol, program: "node", protocol, aliases: [protocol], args: (p, m) => [...(m ? ["--model", m] : []), p] });
  let brain: LlmService | undefined, delegate: BrainService | undefined;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", optional: ["agent"], slots: [
    { id: "test.main", service: "llm", section: "cerveau", label: "Principal" },
    { id: "test.delegate", service: "delegate", section: "cerveau", label: "Délégué" },
  ] }, async apply(ctx) { brain = await ctx.slot("test.main"); delegate = await ctx.slot("test.delegate"); } });
  const k = new Kernel({ home, logger: () => {}, audit, secrets, plugins: [mcp, plugin, probe] }); kernels.push(k);
  k.tools.register("test", ["agenda", "lancer_travail_agent", "ouvrir_session_agent"].map((name) => ({ name, description: name,
    inputSchema: { type: "object", properties: {} }, level: "read" as const, handler: async () => ({ status: "done" as const, text: "ok" }) })));
  await k.applyConfig({ slots: { "test.main": `agent/${protocol}`, "test.delegate": `agent/${protocol}` }, plugins: [
    { id: "mcp", plugin: "test-mcp" }, { id: "agent", plugin: `agent-${protocol}`, config: {
      exe: process.execPath, exeArgs: [fixture, protocol], model: "provider/main", delegateModel: "provider/delegate", timeout_s,
    } }, { id: "probe", plugin: "probe" },
  ] });
  return { k, home, audit, secrets, scopes, brain: () => brain!, delegate: () => delegate! };
}

async function collect(brain: BrainService, text: string, signal?: AbortSignal) {
  const events: BrainEvent[] = [];
  for await (const e of brain.run({ text, session: "s", mode: "text", signal })) events.push(e);
  const done = events.find((e) => e.type === "done");
  return { events, text: done?.type === "done" ? done.text : "" };
}

describe.each(["opencode", "pi", "omp", "hermes"] as const)("agent piloté %s", (protocol) => {
  it("offres principal/délégué, profil privé, secrets au coffre, jeton restreint et historique réinitialisable", async () => {
    const b = await boot(protocol);
    const p = b.k.items.provider("agent-agent")!;
    expect((await p.update!(protocol, { apiKey: "TEST-KEY", provider: "anthropic" })).ok).toBe(true);
    expect(readFileSync(join(b.home, "items", "agent.json"), "utf8")).not.toContain("TEST-KEY");
    const first = JSON.parse((await collect(b.brain().agent!, "bonjour")).text);
    expect(first.env.FLOPPY_MCP_TOKEN).toBe("SCOPE-TOKEN");
    expect(first.env.ANTHROPIC_API_KEY).toBe("TEST-KEY");
    expect(first.env.OPENAI_API_KEY).toBeUndefined();
    expect(first.env.CLAUDECODE).toBeUndefined();
    expect(first.env.HOME).not.toBe(process.env.USERPROFILE);
    expect(existsSync(first.env.HOME)).toBe(false);
    expect(JSON.stringify(first.config)).not.toContain("TEST-KEY");
    if (protocol === "opencode") {
      expect(first.config.agents.floppy.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
      expect(first.config.agents.floppy.permissions).toContainEqual({ action: "floppy_agenda", resource: "*", effect: "allow" });
      expect(Object.keys(first.config.mcp.servers)).toEqual(["floppy"]);
    } else if (protocol === "hermes") expect(Object.keys(first.config.mcp_servers)).toEqual(["floppy"]);
    else {
      expect(Object.keys(first.config.mcpServers)).toEqual(["floppy"]);
      expect(first.args).toContain("--no-extensions");
      expect(first.args).toContain(protocol === "pi" ? "--no-approve" : "--no-tools");
    }
    expect(first.model ?? first.args[first.args.indexOf("--model") + 1]).toBe("provider/main");
    expect(b.scopes[0]!.closed).toBe(true);
    expect(b.scopes[0]!.tools).toContain("agenda");
    expect(b.scopes[0]!.tools).not.toContain("lancer_travail_agent");
    expect(b.scopes[0]!.tools).not.toContain("ouvrir_session_agent");
    const second = JSON.parse((await collect(b.delegate(), "difficile")).text);
    expect(second.model ?? second.args[second.args.indexOf("--model") + 1]).toBe("provider/delegate");
    const next = JSON.parse((await collect(b.brain().agent!, "suite")).text);
    expect(next.prompt).toContain("bonjour");
    b.brain().agent!.reset("s");
    const reset = JSON.parse((await collect(b.brain().agent!, "nouveau")).text);
    expect(reset.prompt).not.toContain("bonjour");
  });

  it("erreur explicite et annulation ferment le profil et rendent l'agent disponible", async () => {
    const b = await boot(protocol);
    await expect(collect(b.brain().agent!, "FAIL")).rejects.toThrow();
    await expect(collect(b.brain().agent!, "HANG", AbortSignal.timeout(200))).rejects.toThrow();
    expect(b.scopes.every((s) => s.closed)).toBe(true);
    expect(JSON.parse((await collect(b.brain().agent!, "après")).text).prompt).toContain("après");
  });

  if (protocol !== "hermes") {
    it("outil Floppy reconnu ; outil natif inattendu, flux invalide, incomplet et sortie non zéro refusés", async () => {
      const b = await boot(protocol);
      expect((await collect(b.brain().agent!, "TOOL")).events).toContainEqual({ type: "tool", name: "agenda", args: { x: 1 } });
      for (const text of ["BADTOOL", "BROKEN", "INCOMPLETE", "CRASH"]) await expect(collect(b.brain().agent!, text)).rejects.toThrow();
      expect(b.audit.records.some((r) => r.kind === "cli.unexpected_tools")).toBe(true);
    });
  }
  else {
    it.each(["DROP", "BADJSON", "REPLAYGAP", "APPROVAL", "BADTOOL", "WRONGSTATUS"])("Hermes : %s échoue sans relancer le travail", async (text) => {
      const b = await boot(protocol);
      await expect(collect(b.brain().agent!, text)).rejects.toThrow();
      expect(b.scopes).toHaveLength(1); expect(b.scopes.every((s) => s.closed)).toBe(true);
    });
  }
});

describe("noms et protocoles", () => {
  it("modèles provider/model et variantes permis ; options et shell refusés", () => {
    expect(validAgentModel("anthropic/claude-opus-4.6")).toBe(true);
    for (const m of ["-m", "opus;calc", "a b", "a\n--tools", "a&b"]) expect(validAgentModel(m)).toBe(false);
    expect(floppyToolName("pi", "mcp__floppy__agenda", ["agenda"])).toBe("agenda");
    expect(floppyToolName("omp", "mcp__floppy_agenda", ["agenda"])).toBe("agenda");
    expect(floppyToolName("omp", "mcp__floppy__agenda", ["agenda"])).toBeUndefined();
    expect(openCodeSystemConfigPaths({ ProgramData: "C:/Data" }, "win32")[0]).toContain("Data");
  });
});
