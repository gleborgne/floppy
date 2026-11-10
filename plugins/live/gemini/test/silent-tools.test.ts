import { it, expect, vi, beforeEach } from "vitest";
import type { Context } from "@floppy/core";
import type { LiveEvent, LiveService } from "@floppy/contracts";
import gemini from "../src/index.ts";

const socket = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(async () => {}), options: undefined as any }));
vi.mock("@floppy/core", async (original) => ({
  ...await original<typeof import("@floppy/core")>(),
  providerConfig: () => ({ availability: () => ({ ready: true }), config: () => ({ model: "test", voice: "test" }), apiKey: () => "test" }),
  connectJsonSocket: async (options: unknown) => { socket.options = options; return socket; },
}));

beforeEach(() => { socket.send.mockClear(); });

async function open(silentTools?: string[], on: (e: LiveEvent) => void = () => {}) {
  let service!: LiveService;
  const ctx = { alive: true, assistant: { language: "fr" }, effect() {}, offer(_name: string, def: { start(ctx: unknown): void }) { def.start({ provide(_name: string, value: LiveService) { service = value; } }); } };
  await gemini.apply(ctx as unknown as Context, { model: "test", voice: "test" });
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const }, level: "read" as const, source: "test" });
  const session = await service.open({ body: "avatar", instructions: "test", tools: [tool("lire"), tool("express_emotion")], signal: AbortSignal.timeout(1000), on, ...(silentTools ? { silentTools } : {}) });
  return { session, declarations: socket.options.start.setup.tools[0].functionDeclarations as { name: string; behavior: string }[] };
}

it("sans outil signal : toutes les fonctions restent bloquantes et les réponses inchangées", async () => {
  const { session, declarations } = await open();
  expect(declarations.map((d) => d.behavior)).toEqual(["BLOCKING", "BLOCKING"]);
  session.toolResult!("a", "express_emotion", { status: "done", text: "ok" });
  expect(socket.send).toHaveBeenCalledExactlyOnceWith({ toolResponse: { functionResponses: [{ id: "a", name: "express_emotion", response: { status: "done", text: "ok" } }] } });
});

it("un outil signal est déclaré non bloquant et sa réponse est silencieuse ; les autres restent inchangés", async () => {
  const { session, declarations } = await open(["express_emotion"]);
  expect(declarations).toMatchObject([{ name: "lire", behavior: "BLOCKING" }, { name: "express_emotion", behavior: "NON_BLOCKING" }]);
  session.toolResult!("a", "express_emotion", { status: "done", text: "ok" });
  session.toolResult!("b", "lire", { status: "done", text: "ok" });
  expect(socket.send.mock.calls.map((c) => c[0])).toEqual([
    { toolResponse: { functionResponses: [{ id: "a", name: "express_emotion", response: { status: "done", text: "ok" }, scheduling: "SILENT" }] } },
    { toolResponse: { functionResponses: [{ id: "b", name: "lire", response: { status: "done", text: "ok" } }] } },
  ]);
});

it("un appel de fonction porte l'époque de lecture en cours", async () => {
  const events: LiveEvent[] = [];
  await open(["express_emotion"], (e) => events.push(e));
  socket.options.on({ toolCall: { functionCalls: [{ id: "c1", name: "express_emotion", args: { emotion: "joy" } }] } });
  expect(events).toEqual([{ type: "tool_call", id: "c1", name: "express_emotion", args: { emotion: "joy" }, generation: 0 }]);
});
