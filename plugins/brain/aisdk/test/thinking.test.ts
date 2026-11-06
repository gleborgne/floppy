// Réflexion « après les outils » : 1re étape sans réflexion, étapes suivantes avec (corps de requête vers llama-server).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin, type BrainService } from "@floppy/core";
import llamacpp from "../../../llm/llamacpp/src/index.ts";
import aisdk from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "brain-think-"));
const gguf = join(dir, "a.gguf");
writeFileSync(gguf, Buffer.alloc(1024));

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const toolReply = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lire", arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
const textReply = chunk({ role: "assistant", content: "Voilà." }) + chunk({}, "stop") + "data: [DONE]\n\n";

const bodies: Record<string, unknown>[] = [];
let server: Server, k: Kernel;
let brain: BrainService | undefined;
const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(ctx) { brain = ctx.get("brain"); } });
const tool = definePlugin({
  manifest: { id: "t", version: "0", licence: "MIT" },
  apply(ctx) { ctx.tools.register([{ name: "lire", description: "Lit.", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => ({ status: "done", text: "ok" }) }]); },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        bodies.push(JSON.parse(body));
        res.setHeader("content-type", "text/event-stream");
        res.end(bodies.length % 2 === 1 ? toolReply : textReply);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "qwen" }] }) : "{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [llamacpp, aisdk, tool, probe] });
  await k.applyConfig({ plugins: [
    { id: "llm", plugin: "llm-llamacpp", config: { port, models: { qwen: { label: "Qwen", model: gguf, reasoning: "tools" } } } },
    { id: "t", plugin: "t" },
    { id: "brain", plugin: "brain-aisdk", config: { emotions: false } },
    { id: "probe", plugin: "probe" },
  ] });
  await k.idle();
});
afterAll(async () => { await k.stopAll(); await new Promise((r) => server.close(r)); });

describe("réflexion après les outils", () => {
  it("coupe la réflexion à la 1re étape et l'active après l'outil", async () => {
    for await (const _ of brain!.run({ text: "lis", session: "s", mode: "voice" })) { /* vider */ }
    expect(bodies.map((b) => (b.chat_template_kwargs as { enable_thinking?: boolean } | undefined)?.enable_thinking)).toEqual([false, true]);
    expect(bodies.map((b) => b.thinking_budget_tokens)).toEqual([0, undefined]);
  });
});
