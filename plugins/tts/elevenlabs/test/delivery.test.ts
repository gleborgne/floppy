import { it, expect, vi } from "vitest";
import type { Context } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import eleven from "../src/index.ts";

const config = vi.hoisted(() => ({ model: "eleven_v3", voice: "test-voice", language: "fr" }));
vi.mock("@floppy/core", async (original) => ({
  ...await original<typeof import("@floppy/core")>(),
  providerConfig: () => ({ availability: () => ({ ready: true }), config: () => config, apiKey: () => "test" }),
}));

it.each(["eleven_v3", "eleven_v4", "eleven_v4_turbo", "eleven_flash_v2_5", "unknown"])("transmet le jeu seulement aux modèles compatibles : %s", async (model) => {
  config.model = model;
  let service!: TtsService;
  const fetch = vi.fn(async (_url: string, _opts: RequestInit) => new Response(new Uint8Array([1, 0])));
  const ctx = { alive: true, fetch, effect() {}, offer(_name: string, def: { start(ctx: unknown): void }) { def.start({ provide(_name: string, value: TtsService) { service = value; } }); } };
  await eleven.apply(ctx as unknown as Context, config);
  const abort = new AbortController();
  const chunks = [];
  for await (const c of service.speak!("C'est réglé.", { signal: abort.signal,
    delivery: { intent: "neutral", profile: "playful", language: "fr", emotion: "proud", intensity: 1.25 } })) chunks.push(c);
  expect(chunks[0]!.pcm).toEqual(new Int16Array([1]));
  const payload = JSON.parse(fetch.mock.calls[0]![1].body as string);
  expect(payload).toMatchObject({ model_id: model, language_code: "fr", text: model.startsWith("eleven_v") ? "[very proud and satisfied] C'est réglé." : "C'est réglé." });
  expect(fetch.mock.calls[0]![0]).toContain("test-voice/stream");
  abort.abort();
  expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
});
