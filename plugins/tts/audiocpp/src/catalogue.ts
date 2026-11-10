// Registre audio.cpp de la version prise en charge, fichiers Hugging Face figés et cache hors ligne.
// Les profils Floppy complètent les fiches amont (licence, voix et ressources) : aucune supposition par tag GGUF.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { T, readJsonFile, writeJsonAtomic, type Context, type OpResult } from "@floppy/core";
import { KNOWN_VOICE_MODELS, type KnownVoiceModel } from "./known-voices.ts";
import { AUDIOCPP_VERSION } from "./known-builds.ts";

const REPO = "audio-cpp/audio.cpp-gguf";
const HF = `https://huggingface.co/${REPO}`;
const API = `https://huggingface.co/api/models/${REPO}`;
const FAMILIES = ["pocket_tts", "qwen3_tts", "supertonic", "voxcpm2", "chatterbox", "voxtral_tts", "fish_audio", "omnivoice"] as const;
const safePath = z.string().max(300).regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/).refine(p => p.split("/").every(s => s && s !== "." && s !== ".."));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.object({ path: safePath, size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: digest });
const Record = z.object({ family: z.enum(FAMILIES), id: z.string().regex(/^[a-z0-9_-]{1,100}$/), name: z.string().min(1).max(200),
  revision, mode: z.enum(["streaming", "offline"]), files: z.array(File).min(1).max(80) });
type Record = z.infer<typeof Record>;
const Cache = z.object({ schema: z.literal(1), server: z.literal(AUDIOCPP_VERSION), updatedAt: z.string().datetime(), records: z.array(Record).max(500) });
const Download = z.object({ kind: z.string().optional(), repo: z.string().optional(), revision: z.string().optional(), gated: z.boolean().optional() });
const Spec = z.object({ family: z.string(), tasks: z.array(z.string()), modes: z.array(z.string()),
  package_defaults: z.object({ download: Download }).optional(),
  packages: z.array(z.object({ id: Record.shape.id, display_name: Record.shape.name, format: z.string(),
    files: z.array(safePath).min(1).max(80), download: Download.optional() })).max(100) });

/** Les poids d'un autre modèle/fine-tune ne doivent pas hériter de la licence ou des voix du modèle de base. */
function profile(family: string, model: string): Omit<KnownVoiceModel, "files" | "model" | "id" | "label"> | undefined {
  if (family === "omnivoice" && /^OmniVoice-GGUF\/omnivoice-[\w.-]+\.gguf$/.test(model)) return {
    family: "omnivoice", language: "", clone: true, voices: [],
    licence: { name: "Apache-2.0", url: "https://github.com/k2-fsa/OmniVoice/blob/master/LICENSE" },
    description: T("Français et clonage. Enregistre ou importe une voix après téléchargement. Génère l'audio par morceaux de texte ; qualité à évaluer.", "French and voice cloning. Record or import a voice after downloading. Generates audio in text chunks; quality to evaluate."),
    tags: [T("français", "French"), T("voix à créer", "create a voice"), T("carte graphique", "graphics card")],
  };
  if (family === "qwen3_tts" && /^Qwen3-TTS-12Hz-(?:0\.6|1\.7)B-Base-GGUF\/qwen3-tts-12hz-(?:0\.6|1\.7)b-base-[\w.-]+\.gguf$/.test(model)) return {
    family: "qwen3_tts", language: "", clone: true, voices: [],
    licence: { name: "Apache-2.0", url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base" },
    description: T("Clonage de voix, dont le français. Enregistre ou importe une voix après téléchargement ; qualité à évaluer.", "Voice cloning, including French. Record or import a voice after downloading; quality to evaluate."),
    tags: [T("français", "French"), T("voix à créer", "create a voice"), T("carte graphique", "graphics card")],
  };
  const seed = KNOWN_VOICE_MODELS.find(k => k.family === family && k.model.slice(0, k.model.lastIndexOf("/")) === model.slice(0, model.lastIndexOf("/"))
    && k.model.replace(/-(?:q8_0|bf16|f16|orig)(?:_v\d+)?\.gguf$/, "") === model.replace(/-(?:q8_0|bf16|f16|orig)(?:_v\d+)?\.gguf$/, ""));
  if (!seed) return undefined;
  // Le port VoxCPM2 signale une dérive sonore du Q8 : garder les poids BF16/originaux.
  if (family === "voxcpm2" && /-q8_0\.gguf$/.test(model)) return undefined;
  return seed;
}

const fingerprint = (files: { sha256?: string }[]) => createHash("sha256").update(files.map(f => f.sha256 ?? "").sort().join("\n")).digest("hex").slice(0, 20);
function entry(r: Record): KnownVoiceModel | undefined {
  const models = r.files.filter(f => f.path.endsWith(".gguf"));
  if (models.length !== 1 || new Set(r.files.map(f => f.path)).size !== r.files.length) return undefined;
  const model = models[0]!;
  const p = profile(r.family, model.path);
  if (!p || (p.mode && p.mode !== r.mode)) return undefined;
  const prefix = `catalogue/${fingerprint(r.files)}`;
  return { ...p, id: `registry-${r.id}-${fingerprint(r.files)}`, label: r.name.replace(/ GGUF$/, ""), mode: r.mode,
    model: `${prefix}/${model.path}`, tags: [...(p.tags ?? []), T(`révision ${r.revision.slice(0, 8)}`, `revision ${r.revision.slice(0, 8)}`)],
    files: r.files.map(f => ({ ...f, path: `${prefix}/${f.path}`, url: `${HF}/resolve/${r.revision}/${f.path}` })),
  };
}

/** Aucun poids téléchargé : seulement huit fiches de modèle et les métadonnées de leurs fichiers. */
export async function fetchCatalogue(fetchFn: typeof fetch, signal: AbortSignal): Promise<Record[]> {
  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const r = await fetchFn(url, { ...init, signal, headers: { "content-type": "application/json", ...init?.headers } });
    if (!r.ok) throw new Error(`catalogue : HTTP ${r.status}`);
    return r.json();
  };
  const [info, ...specs] = await Promise.all([
    json(API).then(x => z.object({ sha: revision, private: z.literal(false).optional(), gated: z.literal(false).optional() }).parse(x)),
    ...FAMILIES.map(async family => {
      const spec = Spec.parse(await json(`https://raw.githubusercontent.com/0xShug0/audio.cpp/${AUDIOCPP_VERSION}/model_specs/${family}.json`));
      if (spec.family !== family || !spec.tasks.includes("tts")) throw new Error(`famille incompatible : ${family}`);
      return spec;
    }),
  ]);
  const sha = (info as { sha: string }).sha;
  const candidates: Omit<Record, "files">[] = [];
  const paths: string[][] = [];
  for (const raw of specs) {
    const spec = raw as z.infer<typeof Spec>;
    const mode = spec.modes.includes("streaming") ? "streaming" : spec.modes.includes("offline") ? "offline" : undefined;
    if (!mode) continue;
    for (const pkg of spec.packages) {
      const download = { ...spec.package_defaults?.download, ...pkg.download };
      if (pkg.format !== "gguf" || download.repo !== REPO || download.kind !== "huggingface_snapshot" || download.gated
        || (download.revision && download.revision !== "main")) continue;
      const models = pkg.files.filter(p => p.endsWith(".gguf"));
      if (models.length !== 1) continue;
      const model = models[0]!;
      const p = profile(spec.family, model);
      if (!p || (p.mode && p.mode !== mode)) continue;
      // Pocket : la fiche amont ne prend qu'une voix ; Floppy garde toutes les empreintes de son profil.
      const seed = KNOWN_VOICE_MODELS.find(k => k.family === "pocket_tts" && k.language === p.language);
      const files = [...new Set([...pkg.files, ...(spec.family === "pocket_tts" ? seed?.files.filter(f => !f.path.endsWith(".gguf")).map(f => f.path) ?? [] : [])])];
      candidates.push({ family: spec.family as Record["family"], id: pkg.id, name: pkg.display_name, revision: sha, mode });
      paths.push(files);
    }
  }
  const wanted = [...new Set(paths.flat())];
  if (!wanted.length) throw new Error("aucun paquet compatible dans le registre");
  const files = new Map<string, z.infer<typeof File>>();
  // L'API paths-info lit les chemins précis au commit choisi, sans pagination de l'immense dépôt GGUF.
  for (let i = 0; i < wanted.length; i += 100) {
    const result = await json(`${API}/paths-info/${sha}`, { method: "POST", body: JSON.stringify({ paths: wanted.slice(i, i + 100) }) });
    for (const f of z.array(z.object({ type: z.string(), path: safePath, size: z.number(), lfs: z.object({ oid: digest, size: z.number() }).optional() })).parse(result)) {
      if (f.type === "file" && f.lfs && f.size === f.lfs.size) files.set(f.path, File.parse({ path: f.path, size: f.size, sha256: f.lfs.oid }));
    }
  }
  const records = candidates.flatMap((c, i) => paths[i]!.every(p => files.has(p)) ? [{ ...c, files: paths[i]!.map(p => files.get(p)!) }] : []);
  if (!records.length) throw new Error("aucun paquet complet avec empreintes SHA-256");
  return records;
}

/** Déclare le bouton d'actualisation. Les lectures du catalogue restent locales, même après un échec réseau. */
export function dynamicCatalogue(ctx: Context, seeds: KnownVoiceModel[]): () => KnownVoiceModel[] {
  const file = join(ctx.home, "tts-audiocpp", `catalogue-${AUDIOCPP_VERSION}.json`);
  const saved = readJsonFile<unknown>(file);
  const cache = Cache.safeParse(saved);
  if (saved && !cache.success) ctx.log("warn", "catalogue audio.cpp : cache incompatible ignoré");
  let records = cache.success ? cache.data.records : [];
  let updatedAt = cache.success ? cache.data.updatedAt : "";
  let failure = false;
  let pending: Promise<OpResult> | undefined;
  const stopped = new AbortController();
  ctx.effect(() => stopped.abort());
  const entries = () => {
    const fingerprints = new Set(seeds.map(s => fingerprint(s.files)));
    const dynamic = records.flatMap(r => { const e = entry(r); return e && !fingerprints.has(fingerprint(r.files)) ? [e] : []; });
    return [...seeds, ...dynamic];
  };
  const update = (): Promise<OpResult> => {
    if (pending) return pending;
    pending = (async (): Promise<OpResult> => {
      try {
        const next = await fetchCatalogue(((url: string, init?: RequestInit) => ctx.fetch(url, { ...init, timeoutMs: 45_000 })) as typeof fetch, AbortSignal.any([stopped.signal, AbortSignal.timeout(45_000)]));
        stopped.signal.throwIfAborted();
        // Garder les anciennes révisions : ni une voix ni un téléchargement en cours ne change de fichier.
        const merged = new Map(records.map(r => [entry(r)?.id, r]));
        for (const r of next) merged.set(entry(r)?.id, r);
        merged.delete(undefined);
        const value = Cache.parse({ schema: 1, server: AUDIOCPP_VERSION, updatedAt: new Date().toISOString(), records: [...merged.values()] });
        writeJsonAtomic(file, value);
        records = value.records; updatedAt = value.updatedAt; failure = false;
        return { ok: true, text: T(`Catalogue actualisé : ${entries().length} modèles et variantes disponibles.`, `Catalogue refreshed: ${entries().length} models and variants available.`) };
      } catch (err) {
        if (!stopped.signal.aborted) { failure = true; ctx.log("warn", "catalogue audio.cpp : actualisation impossible", { err: String(err) }); }
        return { ok: false, text: T("Actualisation impossible. Le catalogue précédent reste disponible ; réessaie quand la connexion fonctionne.", "Refresh failed. The previous catalogue is still available; try again when connected.") };
      } finally { pending = undefined; if (!stopped.signal.aborted) ctx.items.changed(); }
    })();
    ctx.items.changed();
    return pending;
  };
  ctx.items.declare({
    id: "local-voice-catalogue", section: "voice", layout: "library", offers: "tts", order: 19,
    label: T("Catalogue en ligne", "Online catalogue"), description: T("audio.cpp et Hugging Face", "audio.cpp and Hugging Face"),
    list: () => [{ id: "catalogue", label: T("Découvrir les modèles et variantes", "Discover models and variants"), enabled: true,
      detail: T("Actualise la liste sans télécharger de modèle. Elle reste consultable hors connexion.", "Refresh the list without downloading models. It remains available offline."),
      tags: [AUDIOCPP_VERSION, ...(updatedAt ? [T(`actualisé le ${updatedAt.slice(0, 10)}`, `updated on ${updatedAt.slice(0, 10)}`)] : [])],
      status: pending ? "loading" : failure ? "error" : undefined,
      statusText: pending ? T("Actualisation…", "Refreshing…") : failure ? T("Connexion impossible ; catalogue conservé.", "Connection failed; catalogue preserved.") : undefined,
      actions: pending ? [] : [{ id: "refresh", label: T("Actualiser le catalogue", "Refresh catalogue") }],
    }, { id: "kokoro", label: "Kokoro · Siwis", enabled: true,
      detail: T("Voix française sur processeur. Installation complémentaire nécessaire : eSpeak et ses données de prononciation. Le téléchargement guidé n'est pas encore disponible.", "French voice on CPU. Additional installation required: eSpeak and its pronunciation data. Guided download is not available yet."),
      actions: [{ id: "documentation", label: T("Documentation", "Documentation") }],
    }],
    action: async (id, action) => id === "catalogue" && action === "refresh" ? update()
      : id === "kokoro" && action === "documentation" ? { ok: true, text: T("Documentation ouverte.", "Documentation opened."), open: `https://github.com/0xShug0/audio.cpp/blob/${AUDIOCPP_VERSION}/tests/kokoro_tts/MULTILINGUAL_GGUF.md` }
        : { ok: false, text: T("Action inconnue.", "Unknown action.") },
  });
  return entries;
}
