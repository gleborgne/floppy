import { describe, it, expect, vi } from "vitest";
import { Kernel, definePlugin, AudioHistory, Pcm16Decoder, readSse } from "../src/index.ts";

describe("choix des fournisseurs de service", () => {
  const choice = { service: "testVoice" as const, section: "voix", label: "Bouche", none: "Locale" };
  const provider = (id: string) => definePlugin({
    manifest: { id, version: "0", licence: "MIT", provides: ["testVoice"], permissions: { cloud: true }, serviceSelection: choice },
    apply(ctx) { ctx.provide("testVoice", { name: id }); },
  });
  it("reste local par défaut ; changer redémarre seulement les consommateurs et persiste", async () => {
    const seen: unknown[] = [], closed: unknown[] = [];
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["testVoice"] },
      apply(ctx) { const value = ctx.maybe("testVoice"); seen.push(value); ctx.effect(() => { closed.push(value); }); },
    });
    const cfg = { plugins: [{ id: "a", plugin: "a" }, { id: "b", plugin: "b" }, { id: "c", plugin: "consumer" }] };
    const k = new Kernel({ logger: () => {}, plugins: [provider("a"), provider("b"), consumer] });
    try {
      await k.applyConfig(cfg);
      expect(k.service("testVoice")).toBeUndefined();
      expect((await k.settings.change("service.testVoice", "b", "ui")).ok).toBe(true);
      expect(k.service("testVoice")).toEqual({ name: "b" });
      expect(seen).toEqual([undefined, { name: "b" }]);
      expect(closed).toEqual([undefined]);
      await k.applyConfig(cfg);
      expect(k.service("testVoice")).toEqual({ name: "b" });
      await k.applyConfig({ plugins: cfg.plugins.filter((p) => p.id !== "b") });
      expect(k.service("testVoice")).toBeUndefined(); // jamais de repli silencieux sur a
      expect(seen.at(-1)).toBeUndefined();
    } finally { await k.stopAll(); }
  });
  it("un choix cloud à la voix passe par l'accord ; refus conserve la sélection", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [provider("a")] });
    try {
      await k.applyConfig({ plugins: [{ id: "a", plugin: "a" }] });
      const change = k.settings.change("service.testVoice", "a", "voice", "avatar");
      await vi.waitFor(() => expect(k.approvals.pending()).toHaveLength(1));
      k.approvals.respond(k.approvals.pending()[0]!.id, false, "test");
      expect((await change).ok).toBe(false);
      expect(k.service("testVoice")).toBeUndefined();
    } finally { await k.stopAll(); }
  });
});

it("une tâche annulée ferme son accord et n'exécute jamais l'outil", async () => {
  const k = new Kernel({ logger: () => {} });
  const run = vi.fn(async () => ({ status: "done" as const, text: "fait" }));
  k.tools.register("test", [{ name: "write", description: "écrire", level: "write", inputSchema: {}, handler: run }]);
  const abort = new AbortController();
  const call = k.tools.call("write", {}, { signal: abort.signal });
  await vi.waitFor(() => expect(k.approvals.pending()).toHaveLength(1));
  const id = k.approvals.pending()[0]!.id;
  abort.abort();
  expect((await call).status).toBe("refused");
  expect(k.approvals.pending()).toHaveLength(0);
  expect(k.approvals.respond(id, true, "late")).toBe(false);
  expect(run).not.toHaveBeenCalled();
  await k.stopAll();
});

it("tampon audio borné : horloge monotone, pas d'audio antérieur après clear", () => {
  const history = new AudioHistory(1);
  history.push(Float32Array.from({ length: 16001 }, (_, i) => i));
  expect(history.slice(0)).toBeUndefined();
  expect([...history.slice(15998)!]).toEqual([15998, 15999, 16000]);
  history.clear();
  expect(history.end).toBe(16001);
  expect(history.slice(15998)).toBeUndefined();
  history.push(new Float32Array([42]));
  expect([...history.slice(16001)!]).toEqual([42]);
});

it("PCM réseau : conserve les demi-échantillons entre blocs et refuse une fin tronquée", () => {
  const decoder = new Pcm16Decoder();
  expect([...decoder.push(new Uint8Array([0xff]))]).toEqual([]);
  expect([...decoder.push(new Uint8Array([0x7f, 0, 0x80]))]).toEqual([32767, -32768]);
  decoder.finish();
  decoder.push(new Uint8Array([0]));
  expect(() => decoder.finish()).toThrow(/tronqué/);
});

it("SSE : reconstruit JSON et UTF-8 coupés en octets individuels", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"été"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const events: unknown[] = [];
  for await (const e of readSse(body)) events.push(e);
  expect(events).toEqual([{ text: "été" }]);
});
