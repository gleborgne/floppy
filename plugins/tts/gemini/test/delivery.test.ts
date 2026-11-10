import { it, expect, vi } from "vitest";
import type { Context } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import gemini from "../src/index.ts";

vi.mock("@floppy/core", async (original) => ({
  ...await original<typeof import("@floppy/core")>(),
  providerConfig: () => ({ availability: () => ({ ready: true }), config: () => ({ model: "gemini-3.1-flash-tts-preview", voice: "Kore" }), apiKey: () => "test" }),
}));

async function fixture() {
  let service!: TtsService;
  const chunk = { candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AQA=" } }] } }] };
  const fetch = vi.fn(async (_url: string, _opts: RequestInit) => new Response(`data: ${JSON.stringify(chunk)}\n\n`));
  const ctx = { alive: true, fetch, effect() {}, offer(_name: string, def: { start(ctx: unknown): void }) { def.start({ provide(_name: string, value: TtsService) { service = value; } }); } };
  await gemini.apply(ctx as unknown as Context, { model: "test", voice: "test" });
  return { service, fetch };
}

it.each(["fr", "en"] as const)("transmet le jeu %s séparé de la transcription et garde la voix choisie", async (language) => {
  const f = await fixture();
  const text = language === "fr" ? "Voici comment se forme un arc-en-ciel." : "Here is how a rainbow forms.";
  const chunks = [];
  for await (const chunk of f.service.speak!(text, { signal: new AbortController().signal,
    delivery: { intent: "playful", profile: "playful", language, tone: "chaleureux", emotion: "surprised", intensity: 1.25 } })) chunks.push(chunk);
  expect(chunks[0]!.pcm).toEqual(new Int16Array([1]));
  const payload = JSON.parse(f.fetch.mock.calls[0]![1].body as string);
  const prompt = payload.contents[0].parts[0].text;
  expect(prompt).toMatch(/^Synthesize speech\./);
  expect(prompt).toContain(language === "fr" ? "malice amicale" : "friendly mischief");
  expect(prompt).toContain(language === "fr" ? "très surpris" : "very surprised");
  expect(prompt.endsWith("\n\n" + text)).toBe(true);
  expect(payload.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
});

it("rassure sans réinjecter le sarcasme et respecte l'annulation du flux", async () => {
  const f = await fixture(); const abort = new AbortController();
  const stream = f.service.speak!("Tout va bien.", { signal: abort.signal,
    delivery: { intent: "reassure", profile: "playful", language: "fr", tone: "Très sarcastique" } })[Symbol.asyncIterator]();
  await stream.next();
  expect(f.fetch.mock.calls[0]![1].body).not.toContain("Très sarcastique");
  expect(f.fetch.mock.calls[0]![1].body).toContain("calme");
  abort.abort(); expect(f.fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  await stream.return?.();
});
