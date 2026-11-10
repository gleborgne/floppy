import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, MemorySecrets, definePlugin, tr, type Context, type ProviderSnapshot } from "@floppy/core";
import { formatBytes, modelLibrary, type LibraryEntry } from "../src/index.ts";

const quiet = () => {};
const DATA = Buffer.alloc(30_000, 7);
let servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); servers = []; });

async function serve(hold = false): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": DATA.length });
    if (hold) res.write(DATA.subarray(0, 1000)); else res.end(DATA);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Un plugin qui déclare une bibliothèque ; `added` note les modèles prêts. */
async function setup(entries: (url: string) => LibraryEntry[], url: string, extra: { search?: (q: string) => Promise<LibraryEntry[]> } = {}) {
  const added: string[] = [];
  const removed: string[] = [];
  let ctx!: Context;
  const p = definePlugin({
    manifest: { id: "plib", version: "0", licence: "MIT", provides: ["stt"], permissions: { net: ["127.0.0.1"] } },
    config: z.object({}),
    apply(c) {
      ctx = c;
      modelLibrary(c, {
        id: "lib", section: "ecoute", offers: "stt", label: "Modèles", entries: () => entries(url),
        installed: (e) => { if (!added.includes(e.id)) added.push(e.id); },
        has: (e) => added.includes(e.id),
        removed: (e) => { removed.push(e.id); },
        ...extra,
      });
    },
  });
  const home = mkdtempSync(join(tmpdir(), "floppy-lib-"));
  const k = new Kernel({ logger: quiet, plugins: [p], home, secrets: new MemorySecrets() });
  await k.applyConfig({ plugins: [{ id: "lib", plugin: "plib" }], services: {} });
  const snap = async (): Promise<ProviderSnapshot> => (await k.items.snapshot()).find((x) => x.id === "lib")!;
  return { k, ctx: () => ctx, added, removed, snap, home };
}

const vad = (url: string): LibraryEntry => ({
  id: "vad", label: { fr: "Silero VAD", en: "Silero VAD" }, files: [{ url: `${url}/vad.onnx`, path: "vad/silero.onnx", size: DATA.length }],
  licence: { name: "MIT", url: "https://example.org/licence" }, tags: ["fr"],
});

const waitFor = async (fn: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("formatBytes", () => {
  it("écrit les tailles dans les deux langues", () => {
    expect(formatBytes(512)).toEqual({ fr: "512 o", en: "512 B" });
    expect(formatBytes(1_234_000_000)).toEqual({ fr: "1,2 Go", en: "1.2 GB" });
    expect(formatBytes(128_000_000)).toEqual({ fr: "128 Mo", en: "128 MB" });
  });
});

describe("modelLibrary", () => {
  it("recopie la note par langue et l'extrait sonore dans l'instantané du catalogue (comme needs et service)", async () => {
    const entry = (u: string): LibraryEntry => ({
      ...vad(u), service: "stt", needs: { memory: 1e9, device: "cpu" }, languages: { fr: "good", en: "fair", de: "poor" }, sample: "https://example.org/extrait.mp3",
    });
    const s = await setup((u) => [entry(u), { ...vad(u), id: "sans-notes" }], await serve());
    const [noted, plain] = (await s.snap()).items;
    expect(noted).toMatchObject({ service: "stt", needs: { memory: 1e9, device: "cpu" }, languages: { fr: "good", en: "fair", de: "poor" }, sample: "https://example.org/extrait.mp3" });
    expect(plain!.languages).toBeUndefined();
    expect(plain!.sample).toBeUndefined();
  });

  it("montre la taille, la licence et le bouton Télécharger", async () => {
    const s = await setup((u) => [vad(u)], await serve());
    const p = await s.snap();
    expect(p).toMatchObject({ layout: "library", offers: "stt", can: { action: true, search: false } });
    const it = p.items[0]!;
    expect(it.tags).toEqual([{ fr: "30 Ko", en: "30 KB" }, "MIT", "fr"]);
    expect(it.actions?.map((a) => a.id)).toEqual(["download", "licence"]);
    expect(it.status).toBeUndefined();
  });

  it("télécharge, prévient le plugin, puis montre « Installé » et Supprimer", async () => {
    const s = await setup((u) => [vad(u)], await serve());
    const r = await s.k.items.run({ op: "action", provider: "lib", id: "vad", action: "download" }, "ui");
    expect(r.ok).toBe(true);
    await waitFor(() => s.added.includes("vad"));
    const it = (await s.snap()).items[0]!;
    expect(it).toMatchObject({ status: "ok", statusText: { fr: "Installé" } });
    expect(it.actions?.map((a) => a.id)).toEqual(["remove", "licence"]);
    expect(existsSync(join(s.ctx().downloads.dir, "vad/silero.onnx"))).toBe(true);
  });

  it("pendant le téléchargement : barre, pourcentage, Annuler", async () => {
    const s = await setup((u) => [vad(u)], await serve(true));
    await s.k.items.run({ op: "action", provider: "lib", id: "vad", action: "download" }, "ui");
    await waitFor(async () => ((await s.snap()).items[0]!.progress ?? 0) > 0);
    const it = (await s.snap()).items[0]!;
    expect(it.status).toBe("loading");
    expect(it.progress).toBeCloseTo(1000 / 30_000);
    expect(tr(it.statusText, "fr")).toBe("3 % · 1 Ko / 30 Ko");
    expect(it.actions?.map((a) => a.id)).toEqual(["cancel"]);
    await s.k.items.run({ op: "action", provider: "lib", id: "vad", action: "cancel" }, "ui");
    await waitFor(async () => (await s.snap()).items[0]!.status === undefined);
    expect((await s.snap()).items[0]!.actions?.[0]?.id).toBe("download");
  });

  it("supprimer garde les fichiers qu'un autre modèle installé utilise", async () => {
    const url = await serve();
    const shared = { url: `${url}/m.gguf`, path: "m/model.gguf", size: DATA.length };
    const entries = (u: string): LibraryEntry[] => [
      { id: "voix-a", label: "A", files: [shared, { url: `${u}/a.wav`, path: "voices/a.wav", size: DATA.length }] },
      { id: "voix-b", label: "B", files: [shared, { url: `${u}/b.wav`, path: "voices/b.wav", size: DATA.length }] },
    ];
    const s = await setup(entries, url);
    const dir = s.ctx().downloads.dir;
    mkdirSync(join(dir, "m"), { recursive: true }); mkdirSync(join(dir, "voices"), { recursive: true });
    for (const f of ["m/model.gguf", "voices/a.wav", "voices/b.wav"]) writeFileSync(join(dir, f), DATA);
    // Sur le disque mais pas encore dans la liste du plugin : « Ajouter à la liste ».
    expect((await s.snap()).items[0]!.actions?.map((a) => a.id)).toEqual(["use", "remove"]);
    await s.k.items.run({ op: "action", provider: "lib", id: "voix-a", action: "remove" }, "ui");
    expect(existsSync(join(dir, "voices/a.wav"))).toBe(false);
    expect(existsSync(join(dir, "m/model.gguf"))).toBe(true);
    expect(s.removed).toEqual(["voix-a"]);
    await s.k.items.run({ op: "action", provider: "lib", id: "voix-b", action: "remove" }, "ui");
    expect(existsSync(join(dir, "m"))).toBe(false); // dossier vidé, retiré
  });

  it("ouvre la licence dans le navigateur", async () => {
    const s = await setup((u) => [vad(u)], await serve());
    const r = await s.k.items.run({ op: "action", provider: "lib", id: "vad", action: "licence" }, "ui");
    expect(r).toMatchObject({ ok: true, open: "https://example.org/licence" });
  });

  it("recherche : rend des éléments, garde un résultat en cours de téléchargement dans la liste", async () => {
    const url = await serve(true);
    const s = await setup(() => [], url, {
      search: async (q) => [{ id: `hf/${q}`, label: q, files: [{ url: `${url}/x.gguf`, path: `hf/${q}.gguf` }] }],
    });
    expect((await s.snap()).can.search).toBe(true);
    const short = await s.k.items.run({ op: "search", provider: "lib", query: "g" }, "ui");
    expect(short.items).toEqual([]);
    const r = await s.k.items.run({ op: "search", provider: "lib", query: "gemma" }, "ui");
    expect(r.items?.map((x) => x.id)).toEqual(["hf/gemma"]);
    expect((await s.snap()).items).toHaveLength(0);
    await s.k.items.run({ op: "action", provider: "lib", id: "hf/gemma", action: "download" }, "ui");
    expect((await s.snap()).items.map((x) => x.id)).toEqual(["hf/gemma"]);
    await s.k.items.run({ op: "action", provider: "lib", id: "hf/gemma", action: "cancel" }, "ui");
  });

  it("refuse la recherche à la voix", async () => {
    const s = await setup(() => [], await serve(), { search: async () => [] });
    expect((await s.k.items.run({ op: "search", provider: "lib", query: "gemma" }, "voice")).ok).toBe(false);
  });
});
