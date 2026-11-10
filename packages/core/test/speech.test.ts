import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, AudioHistory, Pcm16Decoder, readSse } from "../src/index.ts";

describe("choix du fournisseur d'un service", () => {
  const provider = (id: string) => definePlugin({
    manifest: { id, version: "0", licence: "MIT", provides: ["testVoice"] },
    apply(ctx) { ctx.provide("testVoice", { name: id }); },
  });
  it("un réglage `service.<nom>` gardé par une ancienne version est ignoré : le fournisseur vient de la config, sinon du premier actif", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-service-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ "service.testVoice": "b" }));
    const plugins = [{ id: "a", plugin: "a" }, { id: "b", plugin: "b" }];
    const k = new Kernel({ logger: () => {}, home, plugins: [provider("a"), provider("b")] });
    try {
      await k.applyConfig({ plugins });
      expect(k.service("testVoice")).toEqual({ name: "a" });
      expect(k.settings.list().some((s) => s.key.startsWith("service."))).toBe(false); // plus aucun réglage de ce genre
      await k.applyConfig({ plugins, services: { testVoice: "b" } });
      expect(k.service("testVoice")).toEqual({ name: "b" });
    } finally { await k.stopAll(); rmSync(home, { recursive: true, force: true }); }
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
