// Voix locale audio.cpp : aides pures (config serveur, requête, SSE -> PCM) et cycle de vie dans le noyau (faux processus, faux fetch).
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import tts, { clean, clones, prepareDir, rateOf, scanGguf, serverConfig, speechRequest, ssePcm, wavPcm } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "tts-audiocpp-"));
const file = (name: string, bytes = 2048) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes)); return p; };
const model = file("qwen3-tts-base.gguf");
const wav = file("ref.wav");
const cfg = { port: 8095, backend: "cpu" as const, device: 0, threads: 4 };

const clone = clean({ label: "Q", model, voix: "clone", refWav: wav, refText: "Bonjour", langue: "fr" });

describe("serverConfig / speechRequest", () => {
  it("Fish S2 traduit le jeu en une balise modérée sans changer les mots ni la voix", () => {
    const fish = clean({ label: "Fish", famille: "fish_audio", model: "fish-audio-s2-pro-q8_0.gguf", voix: "clone", refWav: wav, refText: "Bonjour" });
    const delivery = { intent: "playful", profile: "playful", language: "fr" } as const;
    expect(speechRequest(fish, "Bien joué !", "fr").input).toBe("Bien joué !");
    expect(speechRequest(fish, "Bien joué !", "fr", delivery)).toMatchObject({ input: "[warm and playful] Bien joué !", voice: "voix", options: { text_chunk_mode: "tag_aware" } });
    expect(speechRequest(fish, "Ça va aller.", "fr", { ...delivery, intent: "reassure", tone: "sarcastique" }).input).toBe("[soft tone] Ça va aller.");
    expect(speechRequest(fish, "Bonjour", "fr", { ...delivery, profile: "discreet", intent: "neutral" }).input).toBe("Bonjour");
    expect(speechRequest({ ...fish, model: "fish-s1.gguf" }, "Bonjour", "fr", delivery).input).toBe("Bonjour");
    expect(speechRequest(clone, "Bonjour", "fr", delivery).input).toBe("Bonjour");
  });
  it("adapte le jeu au CustomVoice 1.7B sans envoyer de consignes dynamiques aux voix clonées", () => {
    const delivery = { intent: "reassure", profile: "playful", language: "fr", tone: "sarcastique" } as const;
    const custom = clean({ label: "Q", model: "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf", voix: "integree", speaker: "Vivian", instruct: "toujours sarcastique" });
    const req = speechRequest(custom, "Ça va aller.", "fr", delivery);
    expect(req.input).toBe("Ça va aller."); expect(req.instructions).toContain("calme"); expect(req.instructions).not.toContain("toujours sarcastique");
    expect(speechRequest(clone, "Bonjour", "fr", delivery)).not.toHaveProperty("instructions");
    expect(speechRequest({ ...custom, model: "qwen3-tts-0.6b-customvoice.gguf", instruct: "" }, "Bonjour", "fr", delivery)).not.toHaveProperty("instructions");
  });
  it("écrit la config du serveur avec la famille et le mode", () => {
    const c = serverConfig(clone, cfg, { voiceDir: "C:\\x\\voices" }) as { models: Record<string, unknown>[]; voice_dir: string; backend: string; port: number };
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8095, backend: "cpu", max_loaded_models: 1, ui: false, voice_dir: "C:/x/voices" });
    expect(c.models[0]).toMatchObject({ family: "qwen3_tts", task: "tts", mode: "streaming" });
    const v = clean({ label: "V", model, famille: "autre", familleAutre: "kokoro_tts", mode: "offline" });
    expect((serverConfig(v, cfg, { voiceDir: "v" }) as { models: Record<string, unknown>[] }).models[0]).toMatchObject({ family: "kokoro_tts", mode: "offline" });
  });

  it("clone : voix + langue ; sans texte, x_vector_only_mode", () => {
    expect(speechRequest(clone, "Salut")).toEqual({ model: "modele", input: "Salut", voice: "voix", stream_format: "sse", language: "fr" });
    const sans = clean({ label: "Q", model, voix: "clone", refWav: wav });
    expect(speechRequest(sans, "x")).toMatchObject({ options: { x_vector_only_mode: true } });
  });

  it("langue : celle du modèle, sinon celle de l'assistant", () => {
    const sans = clean({ label: "Q", model, voix: "clone", refWav: wav });
    expect(sans.langue).toBe("");
    expect(speechRequest(sans, "Hi", "en")).toMatchObject({ language: "en" });
    expect(speechRequest(sans, "Salut", "fr")).toMatchObject({ language: "fr" });
    expect(speechRequest(clone, "Salut", "en")).toMatchObject({ language: "fr" });
  });

  it("voxcpm2 : retry_badcase false ; voix intégrée : voice_id ; style : instructions", () => {
    const vox = clean({ label: "V", model, famille: "voxcpm2", voix: "clone", refWav: wav, refText: "a" });
    expect(speechRequest(vox, "x")).toMatchObject({ options: { retry_badcase: false } });
    expect(rateOf(vox)).toBe(48000);
    expect(rateOf(clone)).toBe(24000);
    expect(rateOf(clean({ label: "a", model, rate: 16000 }))).toBe(16000);
    const int = clean({ label: "I", model, voix: "integree", speaker: "Vivian", instruct: "calme" });
    const r = speechRequest(int, "x");
    expect(r).toMatchObject({ options: { voice_id: "Vivian" }, instructions: "calme" });
    expect(r).not.toHaveProperty("voice");
  });

  it("voix pour le processeur : Pocket TTS clonée sans texte, Supertonic intégrée ; bonnes fréquences", () => {
    const pocket = clean({ label: "P", model, famille: "pocket_tts", voix: "clone", refWav: wav });
    expect(pocket.famille).toBe("pocket_tts");
    expect(rateOf(pocket)).toBe(24000);
    // x_vector_only_mode est propre à Qwen3 et VoxCPM2 : Pocket TTS refuserait une option inconnue.
    expect(speechRequest(pocket, "Salut", "fr")).toEqual({ model: "modele", input: "Salut", voice: "voix", stream_format: "sse", language: "fr" });
    const st = clean({ label: "S", model, famille: "supertonic", voix: "integree", speaker: "F1" });
    expect(rateOf(st)).toBe(44100);
    expect(speechRequest(st, "Salut", "fr")).toMatchObject({ options: { voice_id: "F1" }, language: "fr" });
    expect(serverConfig(st, { ...cfg, backend: "cpu" }, { voiceDir: "v" })).toMatchObject({ backend: "cpu", models: [{ family: "supertonic" }] });
  });

  it("hors ligne : pas de stream_format", () => {
    expect(speechRequest(clean({ label: "a", model, mode: "offline" }), "x")).not.toHaveProperty("stream_format");
  });

  it("prepareDir copie la voix et écrit prompt_text + server.json", () => {
    const d = join(dir, "work");
    const f = prepareDir(d, clone, cfg);
    expect(f).toBe(join(d, "server.json"));
    expect(existsSync(join(d, "voices", "voix.wav"))).toBe(true);
    expect(readFileSync(join(d, "voices", "prompt_text"), "utf8")).toBe("voix|Bonjour\n");
    expect(JSON.parse(readFileSync(f, "utf8")).models[0].id).toBe("modele");
  });

  it("scan : les noms de voix d'abord", () => {
    const sd = mkdtempSync(join(tmpdir(), "scan-"));
    for (const n of ["llm.gguf", "kokoro-82m.gguf", "mmproj-x.gguf"]) writeFileSync(join(sd, n), "x");
    expect(scanGguf([sd]).map((p) => p.split(/[\\/]/).pop())).toEqual(["kokoro-82m.gguf", "llm.gguf"]);
  });
});

const b64 = (...samples: number[]) => Buffer.from(new Int16Array(samples).buffer).toString("base64");
const sse = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
async function collect(chunks: Uint8Array[]): Promise<number[]> {
  async function* gen() { for (const c of chunks) yield c; }
  const out: number[] = [];
  for await (const p of ssePcm(gen())) out.push(...p);
  return out;
}

describe("ssePcm", () => {
  const text = sse({ type: "speech.audio.delta", audio: b64(1, 2, 3) }) + ": ping\n\n" + sse({ type: "speech.created" }) + sse({ type: "speech.audio.delta", audio: b64(4, 5) }) + "data: [DONE]\n\n";
  const all = new TextEncoder().encode(text);

  it("lit les événements audio et ignore les autres", async () => {
    expect(await collect([all])).toEqual([1, 2, 3, 4, 5]);
  });

  it("coupures n'importe où (octet par octet)", async () => {
    expect(await collect([...all].map((b) => Uint8Array.of(b)))).toEqual([1, 2, 3, 4, 5]);
  });

  it("coupure au milieu d'un échantillon entre deux événements", async () => {
    const raw = Buffer.from(new Int16Array([10, 20, 30]).buffer);
    const a = raw.subarray(0, 3).toString("base64"); // 1,5 échantillon
    const b = raw.subarray(3).toString("base64"); // 1,5 échantillon
    const t = new TextEncoder().encode(sse({ type: "speech.audio.delta", audio: a }) + sse({ type: "speech.audio.delta", audio: b }));
    expect(await collect([t])).toEqual([10, 20, 30]);
  });

  it("dernière ligne sans saut de ligne ; fins de ligne CRLF", async () => {
    const t = new TextEncoder().encode(`data: ${JSON.stringify({ type: "speech.audio.delta", audio: b64(7) })}\r\n\r\ndata: ${JSON.stringify({ audio: b64(8) })}`);
    expect(await collect([t])).toEqual([7, 8]);
  });

  it("événement d'erreur : erreur en français", async () => {
    const t = new TextEncoder().encode(sse({ type: "error", error: { message: "modèle pas chargé" } }));
    await expect(collect([t])).rejects.toThrow("la voix locale a répondu une erreur : modèle pas chargé");
  });

  it("flux tronqué au milieu d'un échantillon : erreur", async () => {
    const t = new TextEncoder().encode(sse({ type: "speech.audio.delta", audio: Buffer.from([1, 2, 3]).toString("base64") }));
    await expect(collect([t])).rejects.toThrow();
  });
});

describe("wavPcm", () => {
  it("lit la fréquence et les échantillons", () => {
    const data = Buffer.from(new Int16Array([5, -5, 9]).buffer);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(96000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    const w = wavPcm(Buffer.concat([h, data]));
    expect(w.rate).toBe(48000);
    expect([...w.pcm]).toEqual([5, -5, 9]);
  });
});

describe("noyau : fork, serveur lancé, voix en flux", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("le slot voice.tts reçoit le service ; parler donne du PCM à la bonne fréquence ; l'arrêt du fork tue le processus", async () => {
    const state = { running: false, killed: 0, bodies: [] as Record<string, unknown>[] };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/health")) { if (!state.running) throw new Error("stopped"); return new Response("{}"); }
      state.bodies.push(JSON.parse(init!.body!));
      // Un événement coupé en deux morceaux réseau.
      const t = new TextEncoder().encode(sse({ type: "speech.audio.delta", audio: b64(1, 2) }) + sse({ type: "speech.audio.delta", audio: b64(3) }));
      return new Response(new ReadableStream({ start(c) { c.enqueue(t.subarray(0, 30)); c.enqueue(t.subarray(30)); c.close(); } }));
    }));
    const spawned: string[][] = [];
    const wrapped: typeof tts = {
      ...tts,
      apply: (ctx, c) => tts.apply({
        ...ctx,
        offer: ((svc: never, def: { start: (f: typeof ctx, id: string) => unknown }) => ctx.offer(svc, {
          ...def,
          start: (f: typeof ctx, id: string) => def.start({
            ...f,
            spawn: ((_cmd: string, args: string[]) => {
              spawned.push(args);
              state.running = true;
              return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { state.killed++; state.running = false; } });
            }) as unknown as typeof ctx.spawn,
          } as typeof ctx, id),
        } as never)) as unknown as typeof ctx.offer,
      } as typeof ctx, c),
    };
    let got: TtsService | undefined;
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: "voice.tts", service: "tts", section: "voix", label: "Voix" }] },
      async apply(c) { got = await c.slot<TtsService>("voice.tts"); },
    });
    const home = mkdtempSync(join(tmpdir(), "tts-home-"));
    const exe = file("fake-server.exe");
    const k = new Kernel({ logger: () => {}, home, plugins: [wrapped, consumer] });
    const base = { id: "tts", plugin: "tts-audiocpp", config: { exe, port: 8095, backend: "cpu", scanDirs: [], models: { q: { label: "Qwen", model, voix: "clone", refWav: wav, refText: "Bonjour" } } } };
    try {
      await k.applyConfig({ plugins: [base], slots: { "voice.tts": "tts/q" } });
      expect(spawned).toEqual([]); // personne ne s'en sert
      await k.applyConfig({ plugins: [base, { id: "c", plugin: "consumer" }], slots: { "voice.tts": "tts/q" } });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]![0]).toBe("--config");
      expect(existsSync(join(home, "tts-audiocpp", "q", "voices", "voix.wav"))).toBe(true);
      expect(got?.name).toContain("Qwen");
      const chunks = [];
      for await (const c of got!.speak!("Bonjour", { signal: new AbortController().signal })) chunks.push(c);
      expect(chunks.every((c) => c.rate === 24000)).toBe(true);
      expect(chunks.flatMap((c) => [...c.pcm])).toEqual([1, 2, 3]);
      expect(state.bodies[0]).toMatchObject({ model: "modele", input: "Bonjour", voice: "voix", stream_format: "sse" });
      const p = (await k.items.snapshot()).find((x) => x.id === "voix-locale")!;
      expect(p).toMatchObject({ section: "voix", offers: "tts" });
      expect(p.items.find((i) => i.id === "q")).toMatchObject({ active: true, status: "ok" });
      expect((p.items.find((i) => i.id === "q")!.detail as { fr: string }).fr).toBe("voix clonée · parle avec qwen3-tts-base.gguf");
      // La taille est celle du modèle : sur le groupe, jamais sur la voix.
      expect((p.items.find((i) => i.id === "q")!.group?.detail as { fr: string }).fr).toBe("0 Go · carte graphique");
      // Le consommateur part : le fork est fermé, le processus tué.
      await k.applyConfig({ plugins: [base], slots: { "voice.tts": "tts/q" } });
      await k.idle(); await k.idle();
      expect(state.killed).toBe(1);
      expect(state.running).toBe(false);
    } finally { await k.stopAll(); }
  });
});

describe("catalogue", () => {
  it("un CustomVoice ajouté à la main propose ses autres voix sans doublon ni téléchargement", async () => {
    const home = mkdtempSync(join(tmpdir(), "tts-custom-"));
    const localModel = file("qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf");
    const k = new Kernel({ logger: () => {}, home, plugins: [tts] });
    await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { models: {
      anna: { label: "Anna", model: localModel, voix: "integree", speaker: "Ono_Anna", langue: "fr" },
      base: { label: "Clone", model, voix: "clone", refWav: wav },
    } } }] });
    const list = async () => (await k.items.snapshot()).find(p => p.id === "voix-locale")!.items;
    try {
      expect((await list()).find(i => i.id === "anna")!.actions).toContainEqual(expect.objectContaining({ id: "add-builtins" }));
      expect((await list()).find(i => i.id === "base")!.actions?.some(a => a.id === "add-builtins")).toBeFalsy();
      const add = () => k.items.run({ op: "action", provider: "voix-locale", id: "anna", action: "add-builtins" }, "ui");
      expect((await add()).ok).toBe(true);
      const voices = (await list()).filter(i => i.values?.model === localModel);
      expect(voices).toHaveLength(9);
      expect(voices.find(i => i.id === "anna")!.label).toBe("Anna");
      expect(voices.map(i => String(i.values!.speaker).toLowerCase())).toEqual(expect.arrayContaining(["serena", "ryan", "aiden", "vivian", "sohee", "ono_anna"]));
      expect(voices.every(i => i.values!.langue === "fr" && i.values!.voix === "integree")).toBe(true);
      expect(new Set(voices.map(i => i.group!.id)).size).toBe(1);
      expect((await add()).ok).toBe(true);
      expect((await list()).filter(i => i.values?.model === localModel)).toHaveLength(9);
      expect((await list()).find(i => i.id === "anna")!.actions?.some(a => a.id === "add-builtins")).toBeFalsy();
      expect((await k.items.run({ op: "action", provider: "voix-locale", id: "base", action: "add-builtins" }, "ui")).ok).toBe(false);
    } finally { await k.stopAll(); }
  });

  it("ajoute, refuse un fichier absent, teste, scanne", async () => {
    const home = mkdtempSync(join(tmpdir(), "tts-home2-"));
    const exe = file("fake2.exe");
    const k = new Kernel({ logger: () => {}, home, plugins: [tts] });
    await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { exe, scanDirs: [dir] } }] });
    try {
      const run = (op: Record<string, unknown>) => k.items.run({ provider: "voix-locale", ...op } as never, "ui");
      expect((await run({ op: "add", kind: "gguf", values: { label: "X", model: join(dir, "absent.gguf") } })).ok).toBe(false);
      const r = await run({ op: "add", kind: "gguf", values: { label: "Ma voix", model, voix: "clone", refWav: wav } });
      expect(r).toMatchObject({ ok: true, id: "ma-voix" });
      const p = (await k.items.snapshot()).find((x) => x.id === "voix-locale")!;
      expect(p.items[0]).toMatchObject({ kind: "voice", enabled: true, active: false });
      const t = await run({ op: "test", kind: "gguf", values: { label: "X", model, voix: "clone", refWav: wav } });
      expect(t).toMatchObject({ ok: true });
      expect(String((t as { text: string }).text)).toContain("Estimation");
      const s = await run({ op: "action", id: "", action: "scan" });
      // Le modèle déjà ajouté n'est plus proposé ; un autre fichier oui.
      expect(String((s as { text: string }).text)).not.toContain("qwen3-tts-base.gguf");
      file("autre-tts.gguf");
      expect(String(((await run({ op: "action", id: "", action: "scan" })) as { text: string }).text)).toContain("autre-tts.gguf");
    } finally { await k.stopAll(); }
  });
});

import { quantOf } from "../src/index.ts";
import { it as itQ, expect as expectQ } from "vitest";
itQ("quantOf : le format en court, lu dans le nom du fichier", () => {
  expectQ(quantOf("C:/audiocpp/models/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf")?.fr).toBe("Q8");
  expectQ(quantOf("C:\m\voxcpm2-q8_0.gguf")?.fr).toBe("Q8");
  expectQ(quantOf("model-Q4_K_M.gguf")?.fr).toBe("Q4");
  expectQ(quantOf("kokoro-bf16.gguf")?.fr).toBe("BF16");
  expectQ(quantOf("qwen3-tts.gguf")).toBeUndefined();
});

// Essai réel, sur le processeur : FLOPPY_TEST_AUDIOCPP=<audiocpp_server>, FLOPPY_TEST_POCKET=<pocket-tts-french-*.gguf>,
// FLOPPY_TEST_REF=<voix.wav> (avec le texte dit dans le .txt du même nom, facultatif).
const realExe = process.env.FLOPPY_TEST_AUDIOCPP, realPocket = process.env.FLOPPY_TEST_POCKET, realRef = process.env.FLOPPY_TEST_REF;
describe.runIf(!!realExe && !!realPocket && !!realRef)("pour de vrai : Pocket TTS sur le processeur", () => {
  it("le plugin lance audio.cpp, clone la voix et parle en flux", async () => {
    let got: TtsService | undefined;
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: "voice.tts", service: "tts", section: "voix", label: "Voix" }] },
      async apply(c) { got = await c.slot<TtsService>("voice.tts"); },
    });
    const txt = realRef!.replace(/\.wav$/i, ".txt");
    const refText = existsSync(txt) ? readFileSync(txt, "utf8").trim() : "";
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "tts-real-")), plugins: [tts, consumer] });
    const base = { id: "tts", plugin: "tts-audiocpp", config: { exe: realExe, port: 8099, backend: "cpu", threads: 4, scanDirs: [],
      models: { p: { label: "Pocket", model: realPocket, famille: "pocket_tts", voix: "clone", refWav: realRef, refText } } } };
    try {
      await k.applyConfig({ plugins: [base, { id: "c", plugin: "consumer" }], slots: { "voice.tts": "tts/p" } });
      for (const phrase of ["Bonjour, je suis Floppy.", "Je tourne sans carte graphique."]) {
        const t0 = performance.now();
        let first = 0, samples = 0, loud = 0;
        for await (const c of got!.speak!(phrase, { signal: new AbortController().signal })) {
          first ||= performance.now() - t0;
          expect(c.rate).toBe(24000);
          samples += c.pcm.length;
          for (const v of c.pcm) loud = Math.max(loud, Math.abs(v));
        }
        console.log(`« ${phrase} » : 1er son ${Math.round(first)} ms, ${(samples / 24000).toFixed(1)} s de voix en ${Math.round(performance.now() - t0)} ms`);
        expect(samples / 24000).toBeGreaterThan(0.8);
        expect(loud).toBeGreaterThan(1000);
      }
    } finally { await k.stopAll(); }
  }, 120_000);
});

describe("bibliothèque : un modèle de voix arrive avec ses voix (réseau simulé)", () => {
  it("télécharge le modèle et ses voix, crée une voix par élément groupée sous le modèle, puis supprime le tout", async () => {
    const { createHash } = await import("node:crypto");
    const { makePlugin } = await import("../src/index.ts");
    const body = (p: string) => Buffer.from(`fichier ${p}`);
    const sha = (p: string) => createHash("sha256").update(body(p)).digest("hex");
    const paths = ["Mini/mini.gguf", "Mini/embeddings/alba.safetensors", "Mini/embeddings/marius.safetensors"];
    const known = [{
      id: "mini", famille: "pocket_tts" as const, langue: "fr", label: { fr: "Mini TTS", en: "Mini TTS" }, model: "Mini/mini.gguf",
      voices: [{ id: "alba", label: "Alba" }, { id: "marius", label: "Marius" }],
      files: paths.map((p) => ({ url: `https://huggingface.co/r/resolve/c/${p}`, path: p, size: body(p).length, sha256: sha(p) })),
    }];
    const fetch = (async (u: string) => {
      const p = u.slice(u.indexOf("/resolve/c/") + "/resolve/c/".length);
      return new Response(body(p), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const k = new Kernel({ logger: () => {}, plugins: [makePlugin(known)], downloads: { fetch } });
    await k.applyConfig({ plugins: [{ id: "tts-local", plugin: "tts-audiocpp", config: { models: {} } }], services: {} });
    const prov = async (id: string) => (await k.items.snapshot()).find((p) => p.id === id)!;

    await k.items.run({ op: "action", provider: "voix-locale-library", id: "mini", action: "download" }, "ui");
    for (let i = 0; i < 100 && (await prov("voix-locale")).items.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const items = (await prov("voix-locale")).items;
    const gguf = join(k.modelsDir, "tts-local", "Mini", "mini.gguf");
    expect(items.map((x) => x.label)).toEqual(["Alba", "Marius"]);
    expect(items[0]!.values).toMatchObject({ model: gguf, famille: "pocket_tts", voix: "integree", speaker: "alba", langue: "fr" });
    expect(items[1]!.values).toMatchObject({ speaker: "marius" });
    expect(items[0]!.group).toMatchObject({ label: { fr: "Mini TTS" } });
    expect(items[0]!.group?.id).toBe(items[1]!.group?.id);
    expect(existsSync(join(k.modelsDir, "tts-local", "Mini", "embeddings", "marius.safetensors"))).toBe(true);

    await k.items.run({ op: "action", provider: "voix-locale-library", id: "mini", action: "remove" }, "ui");
    expect((await prov("voix-locale")).items).toHaveLength(0);
    expect(existsSync(gguf)).toBe(false);
  });

  it("les modèles connus : adresses figées, une empreinte par fichier, le GGUF et une voix par fichier d'empreinte", async () => {
    const { KNOWN_VOICE_MODELS } = await import("../src/known-voices.ts");
    for (const m of KNOWN_VOICE_MODELS) {
      expect(m.files.some((f) => f.path === m.model)).toBe(true);
      if (m.clone) { expect(m.voices).toEqual([]); expect(clones(clean({ famille: m.famille, model: m.model }))).toBe(true); }
      else expect(m.voices.length).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      }
      if (m.famille === "pocket_tts") expect(m.files.length).toBe(m.voices.length + 1);
    }
  });
});

describe("ce que demande une voix (premier lancement)", () => {
  it("Pocket TTS et Supertonic : processeur ; Qwen3-TTS : puce graphique (CUDA, Vulkan, Metal)", async () => {
    const { voiceNeeds } = await import("../src/index.ts");
    expect(voiceNeeds({ famille: "pocket_tts" })).toMatchObject({ device: "cpu" });
    expect(voiceNeeds({ famille: "supertonic" })).toMatchObject({ device: "cpu" });
    expect(voiceNeeds({ famille: "qwen3_tts" })).toMatchObject({ device: "gpu", backends: ["cuda", "vulkan", "metal"] });
  });
});
