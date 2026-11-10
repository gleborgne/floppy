// Les appels ponctuels au llama-server passent par le fetch du contexte (ctx.fetch), avec une borne choisie.
import { describe, it, expect } from "vitest";
import { localComplete } from "../src/index.ts";

describe("localComplete", () => {
  it("passe par le fetch donné, avec une borne de 5 min pour la réponse entière", async () => {
    const seen: { url: string; timeoutMs?: number; body: { model?: string } }[] = [];
    const http = (async (url: string | URL, init?: RequestInit & { timeoutMs?: number }) => {
      seen.push({ url: String(url), ...(init?.timeoutMs ? { timeoutMs: init.timeoutMs } : {}), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: " bonjour " } }] }));
    });
    const r = await localComplete(http, "http://127.0.0.1:8080/v1", "m", { system: "s", prompt: "p" });
    expect(r).toEqual({ text: "bonjour" });
    expect(seen).toEqual([{ url: "http://127.0.0.1:8080/v1/chat/completions", timeoutMs: 300_000, body: expect.objectContaining({ model: "m" }) }]);
  });
});
