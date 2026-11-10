// Service `completion` du fournisseur OpenAI-compatible : faux serveur HTTP, slot emprunté par un consommateur.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, MemorySecrets, definePlugin, type Context } from "@floppy/core";
import openai from "../src/index.ts";

type Svc = { complete(r: { system: string; prompt: string; schema?: Record<string, unknown>; signal?: AbortSignal }): Promise<{ text: string; json?: unknown }>; label?: string; cloud?: boolean };

const KEY = "sk-secret-456";
const seen: { url: string; auth?: string; body: any }[] = [];
let fake: Server;
let k: Kernel;
let ctxRef: Context;
/** Texte renvoyé par le faux modèle pour le prochain appel. */
let content = "bonjour";
let status = 200;

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      res.statusCode = status;
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  const secrets = new MemorySecrets();
  secrets.set("llm-openai/mistral/apiKey", KEY);
  const user = definePlugin({
    manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "watch.triage", service: "completion", section: "watch", label: "Tri", none: "Aucun" }] },
    apply(ctx) { ctxRef = ctx; },
  });
  k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "llm-compl-")), secrets, plugins: [openai, user] });
  await k.applyConfig({
    slots: { "watch.triage": "llmremote/mistral" },
    plugins: [
      { id: "llmremote", plugin: "llm-openai", config: { models: { mistral: { label: "Mistral", baseURL: base, model: "mistral-small", cloud: true } } } },
      { id: "u", plugin: "user" },
    ],
  });
});
afterAll(async () => { await k.stopAll(); fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });

const borrow = async () => (await ctxRef.borrow<Svc>("watch.triage"))!;

describe("completion llm-openai", () => {
  it("slot : appel au modèle choisi avec la clé du coffre", async () => {
    const b = await borrow();
    expect(b.service).toMatchObject({ label: "Mistral", cloud: true });
    content = "résumé court";
    const r = await b.service.complete({ system: "Sois bref.", prompt: "Un long texte" });
    b.release();
    expect(r).toEqual({ text: "résumé court" });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ url: "/v1/chat/completions", auth: `Bearer ${KEY}` });
    expect(last.body.model).toBe("mistral-small");
    expect(last.body.messages).toEqual([{ role: "system", content: "Sois bref." }, { role: "user", content: "Un long texte" }]);
    expect(last.body.response_format).toBeUndefined();
  });

  it("avec schéma : response_format json_schema, JSON lu (même entouré de ```)", async () => {
    const b = await borrow();
    const schema = { type: "object", properties: { note: { type: "number" } } };
    content = '```json\n{"note": 4}\n```';
    const r = await b.service.complete({ system: "Note.", prompt: "x", schema });
    b.release();
    expect(r.json).toEqual({ note: 4 });
    expect(seen.at(-1)!.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "reponse", schema, strict: false } });
    expect(seen.at(-1)!.body.messages[0].content).toContain("JSON valide");
  });

  it("erreurs : JSON invalide, erreur HTTP", async () => {
    const b = await borrow();
    content = "pas du json";
    await expect(b.service.complete({ system: "s", prompt: "x", schema: { type: "object" } })).rejects.toThrow(/JSON valide/);
    status = 401;
    await expect(b.service.complete({ system: "s", prompt: "x" })).rejects.toThrow(/refuse la clé/);
    status = 500;
    await expect(b.service.complete({ system: "s", prompt: "x" })).rejects.toThrow(/erreur 500/);
    status = 200;
    b.release();
  });
});
