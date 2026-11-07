import { it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, pcmWav, wavDataUrl } from "@floppy/core";
import { makePlugin, clean, clones, rateOf, speechRequest, trialReference, voiceNeeds } from "../src/index.ts";
import { fetchCatalogue } from "../src/catalogue.ts";
import { AUDIOCPP_VERSION } from "../src/known-builds.ts";
import { KNOWN_VOICE_MODELS, type KnownVoiceModel } from "../src/known-voices.ts";

afterEach(() => vi.unstubAllGlobals());
const omni = "OmniVoice-GGUF/omnivoice-q8_0.gguf";
const chatter = "Chatterbox-GGUF/chatterbox-f16.gguf";
const qwen = "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-bf16.gguf";
const vox = "Voxtral-4B-TTS-2603-GGUF/voxtral-4b-tts-2603-bf16.gguf";
const pocket = "PocketTTS-GGUF/french/pocket-tts-french-bf16.gguf";
const payload = (path: string, rev: string) => Buffer.from(`${rev}:${path}`);
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function network() {
  const state = { revision: "a".repeat(40), fail: false, omit: "", invalid: false };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (state.fail) throw new Error("hors connexion");
    const url = String(input);
    const result = (x: unknown) => new Response(JSON.stringify(x));
    const pack = (id: string, path: string) => ({ id, display_name: id, format: "gguf", files: [path] });
    if (url.includes("/model_specs/")) {
      expect(url).toContain(`/${AUDIOCPP_VERSION}/`);
      const family = url.split("/").at(-1)!.replace(".json", "");
      const packages = family === "omnivoice" ? [pack("omnivoice_q8", state.invalid ? "../escape.gguf" : omni),
        pack("other", "Other/other.gguf"), { ...pack("external", omni), download: { repo: "another/repo" } }, { ...pack("unsafe", omni), format: "safetensors" }]
        : family === "chatterbox" ? [pack("chatterbox_f16", chatter)]
          : family === "qwen3_tts" ? [pack("qwen_base_bf16", qwen), pack("qwen_design", "Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf")]
            : family === "voxtral_tts" ? [pack("voxtral_bf16", vox)]
              : family === "voxcpm2" ? [pack("voxcpm2_q8", "VoxCPM2-GGUF/voxcpm2-q8_0.gguf"), pack("finetune", "VoxCPM2-GGUF/finetune/vocalrender-pro-orig.gguf")]
                : family === "pocket_tts" ? [pack("pocket_fr_bf16", pocket)] : [];
      return result({ family, tasks: ["tts"], modes: family === "chatterbox" ? ["offline"] : ["offline", "streaming"], packages,
        package_defaults: { download: { kind: "huggingface_snapshot", repo: "audio-cpp/audio.cpp-gguf", revision: "main" } } });
    }
    if (url.endsWith("/api/models/audio-cpp/audio.cpp-gguf")) return result({ sha: state.revision, private: false, gated: false });
    if (url.includes("/paths-info/")) {
      const rev = url.split("/").at(-1)!;
      const paths = JSON.parse(String(init!.body)).paths as string[];
      return result(paths.filter(p => p !== state.omit).map(path => { const data = payload(path, rev); return { type: "file", path, size: data.length, lfs: { oid: hash(data), size: data.length } }; }));
    }
    const resolved = /\/resolve\/([a-f0-9]{40})\/(.+)$/.exec(url);
    if (resolved) return new Response(payload(resolved[2]!, resolved[1]!));
    throw new Error(`requête inattendue : ${url}`);
  }) as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  return { state, fetch };
}

it("croise les fiches versionnées et les empreintes, écarte les familles/variantes sans profil, complète Pocket", async () => {
  const n = network();
  const records = await fetchCatalogue(n.fetch, AbortSignal.timeout(5000));
  expect(records.map(r => r.family)).toEqual(["pocket_tts", "qwen3_tts", "chatterbox", "voxtral_tts", "omnivoice"]);
  expect(records.find(r => r.family === "chatterbox")!.mode).toBe("offline");
  expect(records.find(r => r.family === "pocket_tts")!.files).toHaveLength(28); // modèle + les 27 voix réellement offertes
  expect(records.every(r => r.revision === n.state.revision)).toBe(true);
  n.state.omit = "PocketTTS-GGUF/french/embeddings/anna.safetensors";
  expect((await fetchCatalogue(n.fetch, AbortSignal.timeout(5000))).some(r => r.family === "pocket_tts")).toBe(false);
  n.state.invalid = true;
  await expect(fetchCatalogue(n.fetch, AbortSignal.timeout(5000))).rejects.toThrow();
});

it("OmniVoice clone à 24 kHz et ne reçoit pas l'option Qwen quand la transcription est vide", () => {
  const v = clean({ famille: "omnivoice", model: omni, voix: "clone", refText: "Bonjour.\nComment vas-tu ?" });
  expect(clones(v)).toBe(true); expect(rateOf(v)).toBe(24000);
  expect(speechRequest(v, "Bonjour", "fr")).toMatchObject({ language: "fr", voice: "voix", stream_format: "sse" });
  expect(trialReference(v)).toEqual({ reference_text: "Bonjour. Comment vas-tu ?" });
  expect(trialReference({ ...v, refText: "" })).toEqual({});
  expect(trialReference({ ...v, famille: "qwen3_tts", refText: "" })).toEqual({ options: { x_vector_only_mode: true } });
  expect(voiceNeeds({ famille: "fish_audio", files: [{ url: "", path: "", size: 12e9 }] }).memory).toBeGreaterThan(12e9);
});

async function boot(home: string, fetch: typeof globalThis.fetch, seeds?: KnownVoiceModel[]) {
  const k = new Kernel({ home, logger: () => {}, plugins: [makePlugin(seeds, [])], downloads: { fetch } });
  await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { models: {} } }] });
  const provider = async (id = "voix-locale-library") => (await k.items.snapshot()).find(p => p.id === id)!;
  const refresh = () => k.items.run({ op: "action", provider: "voix-locale-catalogue", id: "catalogue", action: "refresh" }, "ui");
  return { k, provider, refresh };
}

it("actualise à la demande, recherche hors ligne, installe OmniVoice puis garde les révisions et le cache après redémarrage", async () => {
  const n = network(); vi.stubGlobal("fetch", n.fetch);
  const home = mkdtempSync(join(tmpdir(), "tts-registry-"));
  const s = await boot(home, n.fetch);
  let id = "", model = "";
  try {
    expect(n.fetch).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([s.refresh(), s.refresh()]);
    expect(a.ok && b.ok).toBe(true);
    expect(n.fetch.mock.calls.filter(([u]) => String(u).endsWith("/model_specs/omnivoice.json"))).toHaveLength(1);
    const list = await s.provider();
    const omniItem = list.items.find(i => String(i.label).includes("omnivoice_q8"))!;
    id = omniItem.id;
    const voxtral = list.items.find(i => String(i.label).includes("voxtral_bf16"))!;
    expect(voxtral.tags).toContain("CC-BY-NC-4.0");
    expect((await s.provider("voix-locale-catalogue")).items.find(i => i.id === "kokoro")!.actions?.map(a => a.id)).toEqual(["documentation"]);
    const count = list.items.length;
    await s.refresh(); expect((await s.provider()).items).toHaveLength(count);
    n.state.fail = true;
    const search = await s.k.items.run({ op: "search", provider: "voix-locale-library", query: "omnivoice" }, "ui");
    expect(search.items?.map(i => i.id)).toContain(id);
    expect((await s.refresh()).ok).toBe(false); expect((await s.provider()).items).toHaveLength(count);
    n.state.fail = false;
    expect((await s.k.items.run({ op: "action", provider: "voix-locale-library", id, action: "download" }, "ui")).ok).toBe(true);
    for (let i = 0; i < 100 && !(await s.provider("voix-locale")).items.length; i++) await new Promise(r => setTimeout(r, 10));
    const voice = (await s.provider("voix-locale")).items[0]!;
    expect(voice.values).toMatchObject({ famille: "omnivoice", voix: "clone" });
    model = String(voice.values!.model);
    const values = { label: "Voix Omni", model, sample: wavDataUrl(pcmWav(16000, new Int16Array(16000))), refText: "" };
    expect((await s.k.items.run({ op: "update", provider: "voix-locale", id: voice.id, values }, "ui")).ok).toBe(true);
    n.state.revision = "b".repeat(40);
    await s.refresh();
    expect((await s.provider()).items.filter(i => String(i.label).includes("omnivoice_q8"))).toHaveLength(2);
    expect((await s.provider("voix-locale")).items[0]!.values!.model).toBe(model);
    expect(readFileSync(model, "utf8")).toBe(payload(omni, "a".repeat(40)).toString());
  } finally { await s.k.stopAll(); }
  n.state.fail = true; n.fetch.mockClear();
  const again = await boot(home, n.fetch);
  try {
    expect((await again.provider()).items.map(i => i.id)).toContain(id);
    expect(n.fetch).not.toHaveBeenCalled();
    expect((await again.k.items.run({ op: "action", provider: "voix-locale-library", id, action: "remove" }, "ui")).ok).toBe(true);
    expect((await again.provider("voix-locale")).items).toHaveLength(0);
  } finally { await again.k.stopAll(); }
});

it("un cache JSON abîmé est mis de côté, le catalogue livré reste utilisable sans réseau", async () => {
  const n = network(); vi.stubGlobal("fetch", n.fetch);
  const home = mkdtempSync(join(tmpdir(), "tts-registry-corrupt-"));
  const first = await boot(home, n.fetch);
  await first.refresh(); await first.k.stopAll();
  writeFileSync(join(home, "tts-audiocpp", `catalogue-${AUDIOCPP_VERSION}.json`), "{broken");
  n.fetch.mockClear();
  const next = await boot(home, n.fetch);
  try {
    expect((await next.provider()).items.map(i => i.id)).toContain("qwen3-tts-customvoice");
    expect(n.fetch).not.toHaveBeenCalled();
    expect(readdirSync(join(home, "tts-audiocpp")).some(p => p.includes(".corrupt-"))).toBe(true);
  } finally { await next.k.stopAll(); }
});

it("ne duplique pas un paquet déjà livré lorsque le commit change mais que ses fichiers sont identiques", async () => {
  const n = network(); vi.stubGlobal("fetch", n.fetch);
  const base = KNOWN_VOICE_MODELS.find(m => m.famille === "chatterbox")!;
  const data = payload(chatter, n.state.revision);
  const seed = { ...base, model: chatter, files: [{ path: chatter, size: data.length, sha256: hash(data), url: "https://huggingface.co/existing/resolve/other/model.gguf" }] };
  const s = await boot(mkdtempSync(join(tmpdir(), "tts-registry-dedup-")), n.fetch, [seed]);
  try {
    await s.refresh();
    const list = (await s.provider()).items;
    expect(list.filter(i => i.id === seed.id || i.id.startsWith("registry-chatterbox"))).toHaveLength(1);
  } finally { await s.k.stopAll(); }
});

it("arrêter le plugin annule l'actualisation sans publier ni écrire de catalogue tardif", async () => {
  let started = 0, aborted = 0;
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    started++;
    init!.signal!.addEventListener("abort", () => { aborted++; reject(init!.signal!.reason); }, { once: true });
  })) as typeof globalThis.fetch;
  vi.stubGlobal("fetch", fetch);
  const home = mkdtempSync(join(tmpdir(), "tts-registry-stop-"));
  const s = await boot(home, fetch);
  const updating = s.refresh();
  for (let i = 0; i < 20 && !started; i++) await new Promise(r => setTimeout(r, 0));
  expect(started).toBeGreaterThan(0);
  await s.k.stopAll();
  expect((await updating).ok).toBe(false);
  expect(aborted).toBe(started);
  expect(existsSync(join(home, "tts-audiocpp", `catalogue-${AUDIOCPP_VERSION}.json`))).toBe(false);
});
