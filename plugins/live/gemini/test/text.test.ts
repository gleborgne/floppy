import { it, expect, vi } from "vitest";
import type { Context } from "@floppy/core";
import type { LiveService } from "@floppy/contracts";
import gemini from "../src/index.ts";

const socket = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("@floppy/core", async (original) => ({
  ...await original<typeof import("@floppy/core")>(),
  providerConfig: () => ({ availability: () => ({ ready: true }), config: () => ({ model: "test", voice: "test" }), apiKey: () => "test" }),
  connectJsonSocket: async () => socket,
}));

it("envoie le texte comme un tour utilisateur complet, sans consigne d'annonce ni audio", async () => {
  let service!: LiveService;
  const ctx = { alive: true, assistant: { language: "fr" }, effect() {}, offer(_name: string, def: { start(ctx: unknown): void }) { def.start({ provide(_name: string, value: LiveService) { service = value; } }); } };
  await gemini.apply(ctx as unknown as Context, { model: "test", voice: "test" });
  const session = await service.open({ body: "avatar", instructions: "test", tools: [], signal: AbortSignal.timeout(1000), on() {} });
  session.sendText!("Ouvre mes notes.");
  expect(socket.send).toHaveBeenCalledExactlyOnceWith({ clientContent: { turns: [{ role: "user", parts: [{ text: "Ouvre mes notes." }] }], turnComplete: true } });
  await session.close();
  session.sendText!("Ignoré après fermeture");
  expect(socket.send).toHaveBeenCalledOnce();
});
