// Phrase de lecture : après le résultat d'un outil, si le modèle reste muet trop longtemps, le cerveau dit qu'il lit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin, type BrainService } from "@floppy/core";
import llamacpp from "../../../llm/llamacpp/src/index.ts";
import aisdk, { READ_PHRASES, pickPhrase } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "brain-read-"));
const gguf = join(dir, "a.gguf");
writeFileSync(gguf, Buffer.alloc(1024));

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const toolReply = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lire_page", arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

let calls = 0;
let delayMs = 0;
let server: Server, k: Kernel;
let brain: BrainService | undefined;
const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(ctx) { brain = ctx.get("brain"); } });
const pageTool = definePlugin({
  manifest: { id: "pagetool", version: "0", licence: "MIT" },
  apply(ctx) {
    ctx.tools.register([{ name: "lire_page", description: "Lit une page.", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => ({ status: "done", text: "Une très longue page." }) }]);
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        calls++;
        res.setHeader("content-type", "text/event-stream");
        if (calls % 2 === 1) { res.end(toolReply); return; }
        // 2e appel : le modèle « lit » longtemps avant son premier mot.
        res.write(chunk({ role: "assistant", content: "" }));
        setTimeout(() => res.end(chunk({ content: "La page parle de chats." }) + chunk({}, "stop") + "data: [DONE]\n\n"), delayMs);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "gemma" }] }) : "{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [llamacpp, aisdk, pageTool, probe] });
  await k.applyConfig({ plugins: [
    { id: "llm", plugin: "llm-llamacpp", config: { port, models: { gemma: { label: "Gemma", model: gguf } } } },
    { id: "pt", plugin: "pagetool" },
    { id: "brain", plugin: "brain-aisdk", config: { emotions: false, readFillerMs: 100 } },
    { id: "probe", plugin: "probe" },
  ] });
  await k.idle();
});
afterAll(async () => { await k.stopAll(); await new Promise((r) => server.close(r)); });

async function said(mode: "voice" | "text", session: string): Promise<string> {
  let text = "";
  for await (const ev of brain!.run({ text: "Lis la page", session, mode })) if (ev.type === "text") text += ev.delta;
  return text;
}

describe("phrase de lecture", () => {
  it("dit une phrase de lecture quand le modèle reste muet après un outil", async () => {
    delayMs = 400;
    const t = await said("voice", "a");
    expect(READ_PHRASES.some((p) => t.startsWith(p))).toBe(true);
    expect(t).toContain("La page parle de chats.");
  });
  it("ne dit rien si le modèle répond vite", async () => {
    delayMs = 0;
    expect((await said("voice", "b")).trim()).toBe("La page parle de chats.");
  });
  it("ne dit rien en mode texte", async () => {
    delayMs = 400;
    expect((await said("text", "c")).trim()).toBe("La page parle de chats.");
  });
});

describe("pickPhrase", () => {
  it("ne répète jamais la phrase précédente", () => {
    let last: string | undefined;
    for (let i = 0; i < 50; i++) { const p = pickPhrase(READ_PHRASES, last); expect(p).not.toBe(last); last = p; }
    expect(pickPhrase(["seule"], "seule")).toBe("seule");
  });
});
