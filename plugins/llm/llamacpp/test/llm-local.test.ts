// Tests du fournisseur « LLM local » : ajout, désactivation, modèle chargé protégé, ajouts à chaud.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin, type LlmService } from "@floppy/core";
import llm, { DEFAULT_SCAN_DIRS, serial, startOrRestore } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "llm-local-"));
const gguf = (name: string, bytes = 2048) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes)); return p; };
const base = gguf("base.gguf");
const other = gguf("other.gguf");

// Petit plugin qui demande le modèle de son slot, comme le fait le cerveau.
let got: LlmService | undefined;
const probe = definePlugin({
  manifest: { id: "probe", version: "0", licence: "MIT", slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" }] },
  async apply(ctx) { got = await ctx.slot<LlmService>("brain.main"); },
});

let fake: Server;
let k: Kernel;
let port = 0;
beforeAll(async () => {
  // Faux llama-server déjà lancé : le plugin le réutilise (aucun processus lancé).
  fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") res.end("{}");
    else if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "gemma" }] }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  port = (fake.address() as AddressInfo).port;
  k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [llm, probe] });
  await k.applyConfig({
    slots: { "brain.main": "llm/gemma" },
    plugins: [{ id: "probe", plugin: "probe" }, { id: "llm", plugin: "llm-llamacpp", config: {
      port, scanDirs: [dir], ollama: false,
      models: {
        gemma: { label: "Gemma", aliases: ["gemma"], model: base, args: ["-fa", "on", "--n-cpu-moe", "12"] },
        second: { label: "Second", model: other },
      },
    } }],
  });
});
afterAll(async () => { await k.stopAll(); await new Promise((r) => fake.close(r)); });

const provider = async () => (await k.items.snapshot()).find((p) => p.id === "llm-local")!;
/** Modèles proposés par le slot (les actifs seulement). */
const offered = () => k.settings.list().find((s) => s.key === "slot.brain.main")!.options!.map((o) => o.value.replace(/^llm\//, ""));

describe("llm-local", () => {
  it("déclare le fournisseur (rubrique cerveau, kind gguf) et garde les modèles de la config", async () => {
    const p = await provider();
    expect(p).toMatchObject({ section: "cerveau", label: { fr: "LLM local", en: "Local LLM" } });
    expect(p.kinds.map((x) => x.id)).toEqual(["gguf"]);
    expect(p.kinds[0]!.fields.map((f) => f.key)).toEqual(["label", "aliases", "model", "spec", "draft", "placement", "nCpuMoe", "gpuMargin", "ctx", "ubatch", "kv", "mmproj", "reasoning", "thinkBudget", "exe", "args"]);
    const g = p.items.find((i) => i.id === "gemma")!;
    expect(g).toMatchObject({ active: true, enabled: true, kind: "gguf" });
    expect(g.values).toMatchObject({ placement: "moe", nCpuMoe: 12, args: ["-fa", "on"] });
    expect(p.offers).toBe("llm");
    // Serveur déjà lancé avec ce modèle : réutilisé tel quel par le fork.
    expect(got).toMatchObject({ model: "gemma", label: "Gemma", baseURL: `http://127.0.0.1:${port}/v1` });
  });

  it("ajoute un modèle à chaud : visible dans le service sans redémarrer", async () => {
    const f = gguf("nouveau.gguf", 4096);
    const r = await k.items.run({ op: "add", provider: "llm-local", kind: "gguf", values: { label: "Nouveau", aliases: ["nouveau"], model: f, placement: "gpu", ctx: 8192, reasoning: "off" } }, "ui");
    expect(r.ok).toBe(true);
    expect(r.id).toBe("nouveau");
    expect(offered()).toContain("nouveau");
    const it = (await provider()).items.find((i) => i.id === "nouveau")!;
    expect(it).toMatchObject({ enabled: true, active: false, removable: true });
    // Les ajouts sont gardés dans le fichier items, pas dans floppy.yml.
    expect(readFileSync(join(dir, "home", "items", "llm.json"), "utf8")).toContain("Nouveau");
  });

  it("refuse un fichier absent", async () => {
    const r = await k.items.run({ op: "add", provider: "llm-local", kind: "gguf", values: { label: "Fantôme", model: join(dir, "nope.gguf") } }, "ui");
    expect(r.ok).toBe(false);
  });

  it("désactiver : disparaît du service, reste dans la liste ; réactiver le remet", async () => {
    expect((await k.items.run({ op: "enable", provider: "llm-local", id: "second", on: false }, "ui")).ok).toBe(true);
    expect(offered()).not.toContain("second");
    expect((await provider()).items.find((i) => i.id === "second")).toMatchObject({ enabled: false });
    expect((await k.items.run({ op: "enable", provider: "llm-local", id: "second", on: true }, "voice")).ok).toBe(true);
    expect(offered()).toContain("second");
  });

  it("refuse de désactiver ou supprimer le modèle chargé", async () => {
    const off = await k.items.run({ op: "enable", provider: "llm-local", id: "gemma", on: false }, "ui");
    expect(off.ok).toBe(false);
    expect(off.text).toMatch(/ne peut pas être désactivé/);
    expect((await k.items.run({ op: "remove", provider: "llm-local", id: "gemma" }, "ui")).ok).toBe(false);
    expect((await provider()).items.find((i) => i.id === "gemma")).toMatchObject({ removable: false, enabled: true });
  });

  it("test : estimation de mémoire ; fichier absent = échec", async () => {
    const ok = await k.items.run({ op: "test", provider: "llm-local", kind: "gguf", values: { label: "x", model: base, placement: "gpu", ctx: 32768 } }, "ui");
    expect(ok.ok).toBe(true);
    expect(ok.text).toMatch(/Estimation/);
    expect((await k.items.run({ op: "test", provider: "llm-local", kind: "gguf", values: { model: join(dir, "x.gguf") } }, "ui")).ok).toBe(false);
  });

  it("scan : trouve les .gguf pas encore dans la liste", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    const f = gguf("sub/trouve.gguf");
    const r = await k.items.run({ op: "action", provider: "llm-local", id: "gemma", action: "scan" }, "ui");
    expect(r.ok).toBe(true);
    expect(r.text).toContain(f);
    expect(r.text).not.toContain("base.gguf");
  });

  it("modifier puis supprimer un modèle ajouté", async () => {
    expect((await k.items.run({ op: "update", provider: "llm-local", id: "nouveau", values: { label: "Nouveau 2", ctx: 4096 } }, "ui")).ok).toBe(true);
    expect((await provider()).items.find((i) => i.id === "nouveau")).toMatchObject({ label: "Nouveau 2", values: { ctx: 4096 } });
    expect((await k.items.run({ op: "remove", provider: "llm-local", id: "nouveau" }, "ui")).ok).toBe(true);
    expect(offered()).not.toContain("nouveau");
  });

  it("l'ajout n'est jamais permis à la voix", async () => {
    const r = await k.items.run({ op: "add", provider: "llm-local", kind: "gguf", values: { label: "V", model: base } }, "voice");
    expect(r.ok).toBe(false);
  });
});

describe("changement de modèle", () => {
  it("aucun chemin propre à un PC dans les défauts : seulement les dossiers de LM Studio", () => {
    expect(DEFAULT_SCAN_DIRS.every((d) => d.startsWith(homedir()))).toBe(true);
  });

  it("programme et dossiers de modèles : réglages jamais modifiables à la voix", async () => {
    const byKey = (key: string) => k.settings.list().find((s) => s.key === key);
    expect(byKey("llm_local_programme")).toMatchObject({ section: "cerveau", type: "text", risk: "cli", value: "" });
    expect(byKey("llm_local_dossiers")).toMatchObject({ section: "cerveau", type: "text", risk: "cli" });
    const r = await k.settings.change("llm_local_programme", "C:/x/evil.exe", "voice");
    expect(r.ok).toBe(false);
  });

  it("serial : les changements passent l'un après l'autre", async () => {
    const run = serial();
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) => async () => {
      log.push(`début ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`fin ${name}`);
      if (fail) throw new Error(name);
    };
    const a = run(task("a", 30, true));
    const b = run(task("b", 1));
    await expect(a).rejects.toThrow("a");
    await b;
    expect(log).toEqual(["début a", "fin a", "début b", "fin b"]);
  });

  it("démarrage raté : l'ancien modèle est relancé, l'erreur reste", async () => {
    const started: string[] = [];
    let stopped = 0;
    const start = async (m: string) => { started.push(m); if (m === "neuf") throw new Error("pas prêt"); };
    await expect(startOrRestore("neuf", "ancien", start, async () => { stopped++; })).rejects.toThrow("pas prêt");
    expect(started).toEqual(["neuf", "ancien"]);
    expect(stopped).toBe(1);
  });
});

describe("choix fait par le slot", () => {
  it("lance le modèle choisi par le slot, jamais l'ancien réglage « cerveau »", async () => {
    const home = join(dir, "home2");
    mkdirSync(join(home, "items"), { recursive: true });
    // Ancien choix gardé par le plugin et ancien réglage « cerveau » : ils ne comptent plus.
    writeFileSync(join(home, "items", "llm.json"), JSON.stringify({ extra: { last: "gemma" } }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ cerveau: "gemma" }));
    const logs: string[] = [];
    const k2 = new Kernel({ logger: (...a: unknown[]) => { logs.push(JSON.stringify(a)); }, home, plugins: [llm, probe] });
    await k2.applyConfig({ slots: { "brain.main": "llm/second" }, plugins: [{ id: "llm", plugin: "llm-llamacpp", config: {
      port: 1, exe: join(dir, "absent.exe"), startTimeout_s: 2, reuse: false,
      models: { gemma: { label: "Gemma", model: base }, second: { label: "Second", model: other } },
    } }, { id: "probe", plugin: "probe" }] }).catch(() => undefined);
    await k2.stopAll();
    expect(logs.join("\n")).toContain("Second");
    expect(logs.join("\n")).not.toContain("lancement de llama-server : Gemma");
  });
});
