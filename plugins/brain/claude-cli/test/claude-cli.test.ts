// Brain claude-cli : prompt construit depuis les outils visibles ; processus lancés par ctx.spawn ; réserve vidée à sa mort.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, definePlugin, type Context } from "@floppy/core";
import type { BrainService, LlmService } from "@floppy/contracts";
import claude, { cliPrompt } from "../src/index.ts";

describe("cliPrompt", () => {
  it("ne cite que les outils visibles", () => {
    const s = cliPrompt("Floppy", [{ name: "agenda_du_jour" }]);
    expect(s).toContain("Tes outils : agenda_du_jour.");
    for (const w of ["Azure DevOps", "Obsidian", "Orca", "ouvrir_url"]) expect(s).not.toContain(w);
    expect(cliPrompt("Floppy", [])).toContain("aucun outil");
  });
  it("suit la langue de l'assistant (français par défaut)", () => {
    expect(cliPrompt("Floppy", [], "fr")).toContain("Réponds en français");
    const en = cliPrompt("Floppy", [{ name: "agenda_du_jour" }], "en");
    expect(en).toContain("Answer in English");
    expect(en).toContain("Your tools: agenda_du_jour.");
    expect(cliPrompt("Floppy", [], "en")).toContain("no tools");
  });
});

describe("brain claude-cli", () => {
  it("déclare label et aliases (processus lancés par ctx.spawn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
    // Faux CLI : un script node qui meurt tout de suite (la réserve doit être vidée, puis relancée à la demande).
    const script = join(dir, "fake.mjs");
    writeFileSync(script, "process.exit(0);");
    // Le manifeste n'autorise que « claude » : on copie node sous ce nom.
    const fakeExe = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    copyFileSync(process.execPath, fakeExe);
    let got: BrainService | undefined;
    let model: LlmService | undefined;
    // Le délégué et le modèle-agent sont offerts : un consommateur les reçoit par ses slots.
    const probe = definePlugin({
      manifest: { id: "probe", version: "0", licence: "MIT", slots: [
        { id: "brain.delegate", service: "delegate", section: "brain", label: "Délégation", none: "Aucune" },
        { id: "brain.main", service: "llm", section: "brain", label: "Cerveau" },
      ] },
      async apply(ctx) { got = await ctx.slot<BrainService>("brain.delegate"); model = await ctx.slot<LlmService>("brain.main"); },
    });
    const mcp = definePlugin({
      manifest: { id: "fakemcp", version: "0", licence: "MIT", provides: ["mcp"] },
      apply(ctx) { ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) }); },
    });
    const k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [claude, probe, mcp] });
    // « c/opus » : choix gardé du temps où Claude avait un élément par modèle ; il revient sur l'élément unique.
    await k.applyConfig({ slots: { "brain.delegate": "c/claude", "brain.main": "c/opus" }, plugins: [
      { id: "mcp", plugin: "fakemcp" },
      { id: "c", plugin: "brain-claude-cli", config: { exe: fakeExe, model: "sonnet" } },
      { id: "probe", plugin: "probe" },
    ] });
    // Deux modèles : Sonnet en principal (config), Opus en délégation (défaut).
    expect(got!.label).toBe("Claude Opus");
    expect(got!.name).toBe("claude:opus");
    expect(got!.aliases).toContain("claude");
    expect(model).toMatchObject({ label: "Claude Sonnet", model: "sonnet", cloud: true });
    // Un seul élément « Claude Code (CLI) » par slot.
    const opts = k.settings.list().find((s) => s.key === "slot.brain.main")!.options!.map((o) => o.value);
    expect(opts).toEqual(["c/claude"]);
    expect(k.settings.list().find((s) => s.key === "slot.brain.main")!.value).toBe("c/claude");
    // Le modèle se choisit dans la page de l'élément : appliqué tout de suite, sans redémarrage.
    const prov = k.items.provider("claude-cli")!;
    const [item] = await prov.list();
    expect(item).toMatchObject({ id: "claude", kind: "cli", editable: true, values: { model: "sonnet", delegateModel: "opus" } });
    expect(prov.kinds![0]!.fields.map((f) => f.key)).toEqual(["model", "delegateModel"]);
    expect(prov.kinds![0]!.fields[0]!.options!.map((o) => o.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect((await prov.update!("claude", { model: "haiku", delegateModel: "sonnet" })).ok).toBe(true);
    expect(model).toMatchObject({ label: "Claude Haiku", model: "haiku" });
    expect(got!.name).toBe("claude:sonnet");
    expect((await prov.update!("claude", { model: "inconnu" })).ok).toBe(false);
    expect((await prov.list())[0]).toMatchObject({ values: { model: "haiku", delegateModel: "sonnet" } });
    // Le faux CLI meurt sans « result » : la fin du tour est tracée avec sa cause.
    for await (const _ of got!.run({ text: "salut", session: "s", mode: "text" })) { /* vidé */ }
    expect(k.audit.tail(20).find((r) => r.kind === "brain.cli")).toMatchObject({ cli: "claude", model: "sonnet", error: "processus terminé", tools: 0 });
    await k.stopAll();
  });
});

describe("completion claude-cli", () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-completion.mjs");
  type Svc = { complete(r: { system: string; prompt: string; schema?: Record<string, unknown>; signal?: AbortSignal }): Promise<{ text: string; json?: unknown }>; label?: string; cloud?: boolean };
  let k: Kernel | undefined;
  afterEach(async () => { await k?.stopAll(); k = undefined; });

  /** Consommateur : un slot « watch.triage » (service completion) emprunté le temps d'un appel. */
  async function boot(item = "sonnet") {
    const dir = mkdtempSync(join(tmpdir(), "claude-compl-"));
    const fakeExe = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    copyFileSync(process.execPath, fakeExe);
    let ctxRef: Context | undefined;
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "watch.triage", service: "completion", section: "watch", label: "Tri", none: "Aucun" }] },
      apply(ctx) { ctxRef = ctx; },
    });
    const mcp = definePlugin({
      manifest: { id: "fakemcp", version: "0", licence: "MIT", provides: ["mcp"] },
      apply(ctx) { ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) }); },
    });
    k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [claude, user, mcp] });
    await k.applyConfig({ slots: { "watch.triage": `c/${item}` }, plugins: [
      { id: "mcp", plugin: "fakemcp" },
      { id: "c", plugin: "brain-claude-cli", config: { exe: fakeExe, exeArgs: [fixture], timeout_s: 5 } },
      { id: "u", plugin: "user" },
    ] });
    return ctxRef!;
  }
  const borrow = async (ctx: Context) => (await ctx.borrow<Svc>("watch.triage"))!;

  it("slot : modèle choisi, sans outil ni MCP, prompt par l'entrée standard", async () => {
    const ctx = await boot("haiku");
    const b = await borrow(ctx);
    expect(b.service).toMatchObject({ label: "Claude Haiku", cloud: true });
    const r = await b.service.complete({ system: "SYS", prompt: "ARGS" });
    b.release();
    const args = JSON.parse(r.text) as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(args).not.toContain("ARGS");
  });

  it("texte simple ; JSON avec schéma (```json et texte autour)", async () => {
    const ctx = await boot();
    const b = await borrow(ctx);
    expect((await b.service.complete({ system: "s", prompt: "bonjour" })).text).toBe("ok:bonjour");
    const r = await b.service.complete({ system: "s", prompt: "FENCE", schema: { type: "object" } });
    expect(r.json).toEqual({ a: 1 });
    b.release();
  });

  it("schéma ajouté aux consignes ; un second essai si le JSON est mauvais", async () => {
    const ctx = await boot();
    const b = await borrow(ctx);
    const a = JSON.parse((await b.service.complete({ system: "SYS", prompt: "ARGS" })).text) as string[];
    expect(a[a.indexOf("--system-prompt") + 1]).not.toContain("schéma");
    const w = (await b.service.complete({ system: "SYS", prompt: "ARGS", schema: { type: "array" } })).json as string[];
    expect(w[w.indexOf("--system-prompt") + 1]).toContain(`Réponds seulement avec un JSON valide qui suit ce schéma : ${JSON.stringify({ type: "array" })}`);
    expect((await b.service.complete({ system: "s", prompt: "RETRY", schema: { type: "object" } })).json).toEqual({ ok: true });
    await expect(b.service.complete({ system: "s", prompt: "NOJSON", schema: { type: "object" } })).rejects.toThrow(/JSON valide/);
    b.release();
  });

  it("erreurs : réponse en erreur, plantage, délai, annulation", async () => {
    const ctx = await boot();
    const b = await borrow(ctx);
    await expect(b.service.complete({ system: "s", prompt: "ERREUR" })).rejects.toThrow(/quota dépassé/);
    await expect(b.service.complete({ system: "s", prompt: "CRASH" })).rejects.toThrow(/code 3.*boum/);
    const ac = new AbortController();
    const p = b.service.complete({ system: "s", prompt: "LENT", signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toThrow(/annulé/);
    b.release();
  });
});
