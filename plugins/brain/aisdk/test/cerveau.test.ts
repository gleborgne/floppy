// Réglage « cerveau » : options mises à jour à chaud (modèles locaux et distants), modèle distant utilisé pour répondre.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, MemorySecrets, definePlugin, tr } from "@floppy/core";
import type { BrainService } from "@floppy/contracts";
import llamacpp from "../../../llm/llamacpp/src/index.ts";
import openai from "../../../llm/openai/src/index.ts";
import aisdk from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "brain-cerveau-"));
const gguf = join(dir, "a.gguf");
const gguf2 = join(dir, "b.gguf");
writeFileSync(gguf, Buffer.alloc(1024));
writeFileSync(gguf2, Buffer.alloc(1024));

const seen: { url: string; auth?: string; model?: string }[] = [];
let local: Server, remote: Server, k: Kernel;
let brain: BrainService | undefined;
const probe = definePlugin({
  manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] },
  apply(ctx) { brain = ctx.get("brain"); },
});

const sse = (text: string) => [
  { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
  { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

beforeAll(async () => {
  local = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "gemma" }] }) : "{}");
  });
  remote = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let model: string | undefined;
      try { model = (JSON.parse(body) as { model?: string }).model; } catch { /* rien */ }
      seen.push({ url: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), ...(model ? { model } : {}) });
      if (req.url === "/v1/chat/completions") { res.setHeader("content-type", "text/event-stream"); res.end(sse("Bonjour du cloud.")); }
      else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "ml" }] })); }
    });
  });
  await Promise.all([local, remote].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  const lport = (local.address() as AddressInfo).port;
  const rport = (remote.address() as AddressInfo).port;
  k = new Kernel({ logger: () => {}, home: join(dir, "home"), secrets: new MemorySecrets(), plugins: [llamacpp, openai, aisdk, probe] });
  await k.applyConfig({ plugins: [
    { id: "llm", plugin: "llm-llamacpp", config: { port: lport, models: { gemma: { label: "Gemma", aliases: ["gemma"], model: gguf } } } },
    { id: "llmremote", plugin: "llm-openai", config: { models: { ml: { label: "Mistral Large", aliases: ["mistral"], baseURL: `http://127.0.0.1:${rport}/v1`, model: "mistral-large-latest" } } } },
    { id: "brain", plugin: "brain-aisdk" },
    { id: "probe", plugin: "probe" },
  ] });
  await k.idle();
});
afterAll(async () => { await k.stopAll(); await Promise.all([local, remote].map((s) => new Promise((r) => s.close(r)))); });

const cerveau = () => k.settings.list().find((s) => s.key === "slot.brain.main")!;
const values = () => cerveau().options!.map((o) => o.value);

describe("slot cerveau principal (brain.main)", () => {
  it("textes fr/en et section cerveau", () => {
    expect(cerveau().section).toBe("brain");
    expect(tr(cerveau().label, "en")).toBe("Main brain");
    expect(cerveau().role).toBe("brain.main");
    // Le ton appartient désormais à conversation, également utilisée sans ce cerveau en Live.
    expect(k.settings.list().find((s) => s.key === "tone")).toBeUndefined();
    // Les anciens réglages ont disparu : le slot les remplace.
    expect(k.settings.list().find((s) => s.key === "cerveau" || s.key === "delegation")).toBeUndefined();
  });

  it("propose les modèles locaux et distants actifs", () => {
    expect(values()).toEqual(["llm/gemma", "llmremote/ml"]);
    expect(cerveau().value).toBe("llm/gemma");
  });

  it("un modèle local ajouté apparaît, désactivé il disparaît des options", async () => {
    await k.items.run({ op: "add", provider: "llm-local", kind: "gguf", values: { label: "Bravo", model: gguf2 } }, "ui");
    expect(values()).toContain("llm/bravo");
    await k.items.run({ op: "enable", provider: "llm-local", id: "bravo", on: false }, "ui");
    expect(values()).not.toContain("llm/bravo");
  });

  it("un modèle distant désactivé disparaît des options ; réactivé il revient", async () => {
    await k.items.run({ op: "enable", provider: "llm-remote", id: "ml", on: false }, "ui");
    expect(values()).toEqual(["llm/gemma"]);
    await k.items.run({ op: "enable", provider: "llm-remote", id: "ml", on: true }, "ui");
    expect(values()).toContain("llmremote/ml");
  });

  it("choisir un modèle distant est un risque « ask » (cloud) ; un modèle local est libre", () => {
    const d = (k.settings as unknown as { defs: Map<string, { def: { riskFor(v: unknown): string } }> }).defs.get("slot.brain.main")!.def;
    expect(d.riskFor("llmremote/ml")).toBe("ask");
    expect(d.riskFor("llm/gemma")).toBe("free");
  });

  it("avec un modèle distant choisi, le cerveau l'appelle avec son adresse et sa clé", async () => {
    k.secrets.set("llm-openai/ml/apiKey", "sk-ml");
    expect((await k.settings.change("slot.brain.main", "llmremote/ml", "cli")).ok).toBe(true);
    expect(cerveau().value).toBe("llmremote/ml");
    let text = "";
    for await (const ev of brain!.run({ text: "Salut", session: "t", mode: "text" })) if (ev.type === "text") text += ev.delta;
    expect(text).toContain("Bonjour du cloud");
    const chat = seen.find((s) => s.url === "/v1/chat/completions")!;
    expect(chat).toMatchObject({ auth: "Bearer sk-ml", model: "mistral-large-latest" });
  });

  it("si le modèle distant choisi est désactivé, le cerveau le dit au lieu de se replier en silence", async () => {
    await k.items.run({ op: "enable", provider: "llm-remote", id: "ml", on: false }, "ui");
    await k.idle(); // le noyau redémarre le cerveau sans ce modèle
    expect(cerveau().value).toBe("llmremote/ml");
    const before = seen.length;
    let text = "";
    for await (const ev of brain!.run({ text: "Salut", session: "t2", mode: "text" })) if (ev.type === "text") text += ev.delta;
    expect(text).toMatch(/désactivé/);
    expect(seen.length).toBe(before); // aucun appel parti, ni vers le distant ni vers le local
    // Choisir le local sort de cette impasse.
    expect((await k.settings.change("slot.brain.main", "llm/gemma", "cli")).ok).toBe(true);
  });

  it("clé d'API absente : message clair, rien n'est envoyé avec « none »", async () => {
    await k.items.run({ op: "enable", provider: "llm-remote", id: "ml", on: true }, "ui");
    k.secrets.delete("llm-openai/ml/apiKey");
    expect((await k.settings.change("slot.brain.main", "llmremote/ml", "cli")).ok).toBe(true);
    const before = seen.length;
    let text = "";
    for await (const ev of brain!.run({ text: "Salut", session: "t3", mode: "text" })) if (ev.type === "text") text += ev.delta;
    expect(text).toMatch(/clé d'API/);
    expect(seen.length).toBe(before);
  });
});
