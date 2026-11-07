// Brain agy-cli : un élément par modèle, maison isolée (Floppy seul en MCP), agent à liste blanche, règles de refus,
// outils MCP signalés, outils intégrés inattendus journalisés.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, MemoryAudit, definePlugin } from "@floppy/core";
import type { BrainService, LlmService } from "@floppy/contracts";
import agy, { agyAgentFile, agySettings } from "../src/index.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agy.mjs");

async function collect(b: BrainService, text: string) {
  let out = "";
  const tools: string[] = [];
  for await (const ev of b.run({ text, session: "s", mode: "text" })) {
    if (ev.type === "text") out += ev.delta;
    else if (ev.type === "tool") tools.push(ev.name);
  }
  return { out, tools };
}

describe("verrous agy", () => {
  it("règles : seulement nos outils MCP et leurs schémas ; ni commande, ni écriture, ni URL", () => {
    const s = JSON.parse(agySettings("C:/x/mcp"));
    expect(s.permissions.allow).toEqual(["mcp(floppy/*)", "read_file(C:/x/mcp)"]);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "unsandboxed(*)"]));
    expect(s.allowNonWorkspaceAccess).toBe(false);
  });
  it("agent : liste blanche view_file seule (pas de search_web), notre prompt", () => {
    const a = agyAgentFile("PROMPT");
    expect(a).toContain("tools: [view_file]\n");
    expect(a).toContain("commandExecutionPolicy: off");
    expect(a.trim().endsWith("PROMPT")).toBe(true);
  });
});

describe("brain agy-cli", () => {
  let k: Kernel | undefined;
  afterEach(async () => { await k?.stopAll(); k = undefined; });

  async function boot(slots: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "agy-cli-"));
    // Le manifeste n'autorise que « agy » : on copie node sous ce nom.
    const fakeExe = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
    copyFileSync(process.execPath, fakeExe);
    let main: LlmService | undefined;
    let dlg: BrainService | undefined;
    const probe = definePlugin({
      manifest: { id: "probe", version: "0", licence: "MIT", slots: [
        { id: "brain.delegate", service: "delegate", section: "cerveau", label: "Délégation", none: "Aucune" },
        { id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" },
      ] },
      async apply(ctx) { main = await ctx.slot<LlmService>("brain.main"); dlg = await ctx.slot<BrainService>("brain.delegate"); },
    });
    const mcp = definePlugin({
      manifest: { id: "fakemcp", version: "0", licence: "MIT", provides: ["mcp"] },
      apply(ctx) { ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "jeton", scoped: () => ({ url: "", token: "", close() {} }) }); },
    });
    const home = join(dir, "home");
    const audit = new MemoryAudit();
    const kernel = new Kernel({ logger: () => {}, home, audit, plugins: [agy, probe, mcp] });
    k = kernel;
    await kernel.applyConfig({ slots, plugins: [
      { id: "mcp", plugin: "fakemcp" },
      { id: "g", plugin: "brain-agy-cli", config: { exe: fakeExe, exeArgs: [fixture], timeout_s: 5 } },
      { id: "probe", plugin: "probe" },
    ] });
    return { main: () => main, dlg: () => dlg, k: kernel, home, audit };
  }

  it("un seul élément ; modèle choisi dans sa page ; maison isolée avec Floppy seul ; agent et règles passés au CLI", async () => {
    const b = await boot({ "brain.main": "g/antigravity", "brain.delegate": "g/antigravity" });
    const opts = b.k.settings.list().find((s) => s.key === "slot.brain.main")!.options!.map((o) => o.value);
    expect(opts).toEqual(["g/antigravity"]);
    const main = b.main()!;
    expect(main).toMatchObject({ label: "Gemini 3.8 Flash", model: "gemini-3.8-flash-low", cloud: true });
    // Délégation par défaut : le 2e modèle (Argon) ; changeable à part du cerveau principal.
    expect(b.dlg()!.name).toBe("agy:gemini-4-argon-medium");
    const prov = b.k.items.provider("agy-cli")!;
    expect((await prov.update!("antigravity", { delegateModel: "gemini-3.8-flash-low" })).ok).toBe(true);
    expect(b.dlg()!.name).toBe("agy:gemini-3.8-flash-low");
    expect(main.model).toBe("gemini-3.8-flash-low");
    const got = JSON.parse((await collect(main.agent!, "bonjour")).out);
    expect(got.home).toBe(join(b.home, "agy-home"));
    expect(Object.keys(got.mcp.mcpServers)).toEqual(["floppy"]);
    expect(got.mcp.mcpServers.floppy).toMatchObject({ serverUrl: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer jeton" } });
    expect(got.agent).toContain("tools: [view_file]");
    expect(got.args[got.args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(got.args[got.args.indexOf("--agent") + 1]).toBe("floppy");
    expect(JSON.parse(got.args[got.args.indexOf("--settings") + 1]).permissions.deny).toContain("command(*)");
  });

  it("outil MCP signalé par son nom ; lecture de schéma ignorée ; outil intégré inattendu journalisé", async () => {
    const b = await boot({ "brain.main": "g/antigravity" });
    const r = await collect(b.main()!.agent!, "outil");
    expect(r.tools).toEqual(["agenda_du_jour"]);
    expect(r.out).toBe("Rien aujourd'hui.");
    expect(b.audit.records).toContainEqual(expect.objectContaining({ kind: "cli.unexpected_tools", cli: "agy", tools: ["search_web"] }));
  });
});
