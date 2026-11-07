// Tests du fournisseur « API compatible OpenAI » avec un faux serveur HTTP : models, chat, clé dans le coffre.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, MemorySecrets, SECRET_SET, definePlugin } from "@floppy/core";
import type { LlmService } from "@floppy/contracts";
import openai from "../src/index.ts";

const KEY = "sk-secret-123";
const seen: { url: string; auth?: string; body?: string }[] = [];
let fake: Server;
let base = "";
let k: Kernel;
let home = "";
const secrets = new MemorySecrets();

// Consommateur d'un slot llm, comme le cerveau : reçoit le modèle distant choisi (fork sans processus).
let svc: LlmService | undefined;
const probe = definePlugin({
  manifest: { id: "probe", version: "0", licence: "MIT", slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" }] },
  async apply(ctx) { svc = await ctx.slot<LlmService>("brain.main"); },
});
/** Modèles offerts (actifs seulement), tels que le slot les propose. */
const offered = () => k.settings.list().find((s) => s.key === "slot.brain.main")!.options!.map((o) => o.value);

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; res.end("{}"); return; }
      if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "mistral-large" }] }));
      else if (req.url === "/v1/chat/completions") res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  home = mkdtempSync(join(tmpdir(), "llm-remote-"));
  k = new Kernel({ logger: () => {}, home, secrets, plugins: [openai, probe] });
  await k.applyConfig({ plugins: [{ id: "probe", plugin: "probe" }, { id: "llmremote", plugin: "llm-openai" }] });
});
afterAll(async () => { await k.stopAll(); await new Promise((r) => fake.close(r)); });

const provider = async () => (await k.items.snapshot()).find((p) => p.id === "llm-remote")!;
const values = (extra: Record<string, unknown> = {}) => ({ label: "Mistral Large", aliases: ["mistral"], baseURL: `${base}/`, model: "mistral-large", apiKey: KEY, cloud: true, ...extra });

describe("llm-remote", () => {
  it("déclare le fournisseur (cerveau, kind openai) ; vide au départ", async () => {
    const p = await provider();
    expect(p).toMatchObject({ section: "cerveau", label: { fr: "API compatible OpenAI", en: "OpenAI-compatible API" } });
    expect(p.kinds.map((x) => x.id)).toEqual(["openai"]);
    expect(p.kinds[0]!.fields.find((f) => f.key === "apiKey")!.type).toBe("secret");
    expect(p.items).toEqual([]);
    expect(p.offers).toBe("llm");
    expect(offered()).toEqual([]);
    expect(svc).toBeUndefined();
  });

  it("test : GET /models avec la clé ; mauvaise clé = refus", async () => {
    const ok = await k.items.run({ op: "test", provider: "llm-remote", kind: "openai", values: values() }, "ui");
    expect(ok).toMatchObject({ ok: true });
    expect(seen.at(-1)).toMatchObject({ url: "/v1/models", auth: `Bearer ${KEY}` });
    const bad = await k.items.run({ op: "test", provider: "llm-remote", kind: "openai", values: values({ apiKey: "mauvaise" }) }, "ui");
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/refuse la clé/);
  });

  it("ajoute : la clé va dans le coffre, jamais dans le fichier ni dans les valeurs", async () => {
    const r = await k.items.run({ op: "add", provider: "llm-remote", kind: "openai", values: values() }, "ui");
    expect(r).toMatchObject({ ok: true, id: "mistral-large" });
    await k.idle(); // le slot a maintenant un modèle : le consommateur redémarre avec lui
    expect(secrets.get("llm-openai/mistral-large/apiKey")).toBe(KEY);
    const file = readFileSync(join(home, "items", "llmremote.json"), "utf8");
    expect(file).not.toContain(KEY);
    expect(file).toContain("mistral-large");
    expect(readdirSync(join(home, "items"))).toEqual(["llmremote.json"]);
    const item = (await provider()).items[0]!;
    expect(item).toMatchObject({ cloud: true, enabled: true, values: { apiKey: SECRET_SET, baseURL: base } });
    expect(JSON.stringify(item)).not.toContain(KEY);
    expect(offered()).toEqual(["llmremote/mistral-large"]);
    const m = svc!;
    expect(m).toMatchObject({ label: "Mistral Large", model: "mistral-large", baseURL: base, cloud: true });
    expect(m.apiKey!()).toBe(KEY);
  });

  it("le modèle distant répond au chat avec l'adresse et la clé", async () => {
    const m = svc!;
    const r = await fetch(`${m.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${m.apiKey!()}` }, body: JSON.stringify({ model: m.model, messages: [] }) });
    expect(r.ok).toBe(true);
  });

  it("modifier sans retaper la clé (SECRET_SET) la garde ; vide l'efface", async () => {
    await k.items.run({ op: "update", provider: "llm-remote", id: "mistral-large", values: values({ label: "Mistral L", apiKey: SECRET_SET }) }, "ui");
    expect(secrets.get("llm-openai/mistral-large/apiKey")).toBe(KEY);
    expect((await provider()).items[0]!.label).toBe("Mistral L");
    await k.items.run({ op: "update", provider: "llm-remote", id: "mistral-large", values: values({ apiKey: "" }) }, "ui");
    expect(secrets.has("llm-openai/mistral-large/apiKey")).toBe(false);
    await k.items.run({ op: "update", provider: "llm-remote", id: "mistral-large", values: values() }, "ui");
  });

  it("désactiver : disparaît du service ; l'activer à la voix demande un accord (cloud)", async () => {
    expect((await k.items.run({ op: "enable", provider: "llm-remote", id: "mistral-large", on: false }, "voice")).ok).toBe(true);
    await k.idle();
    expect(offered()).toEqual([]);
    expect(svc).toBeUndefined(); // le consommateur a redémarré sans lui
    expect((await provider()).items[0]).toMatchObject({ enabled: false });
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, false, "test"); });
    const r = await k.items.run({ op: "enable", provider: "llm-remote", id: "mistral-large", on: true }, "voice");
    expect(r.ok).toBe(false);
    expect(offered()).toEqual([]);
    expect((await k.items.run({ op: "enable", provider: "llm-remote", id: "mistral-large", on: true }, "ui")).ok).toBe(true);
  });

  it("supprimer efface aussi la clé", async () => {
    expect((await k.items.run({ op: "remove", provider: "llm-remote", id: "mistral-large" }, "ui")).ok).toBe(true);
    expect(offered()).toEqual([]);
    expect(secrets.has("llm-openai/mistral-large/apiKey")).toBe(false);
  });
});
