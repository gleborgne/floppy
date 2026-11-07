// Plugin `stt-sherpa` : lecteur sherpa-onnx (dans le processus, sur le processeur). Il fait tourner des modèles ONNX :
// - détecteur de parole Silero (un fichier .onnx) -> service `vad` (slot listen.vad) ;
// - transcription par transducteur, ex. Parakeet TDT (un dossier) -> service `stt` (slot listen.stt).
// Les modèles sont des éléments de son catalogue (Réglages → Écoute). Chacun est offert au service qui correspond à
// ses fichiers, et chargé dans un fork seulement quand le plugin Écoute s'en sert.
import { resolve } from "node:path";
import { z } from "zod";
import { definePlugin, modelLibrary, T, TextError, tr, type ItemInfo, type ItemKind, type OpResult, type PluginDef, type SttService, type VadEvent, type VadService, type VadStream } from "@floppy/core";
import { detect, recognizerConfig, vadConfig, type Detected } from "./models.ts";
import { realNative, type Native } from "./native.ts";
import { KNOWN_MODELS, type KnownModel } from "./known-models.ts";

export { detect } from "./models.ts";

const Model = z.object({
  label: z.string().min(1),
  /** Fichier .onnx (détecteur) ou dossier (transcription). */
  path: z.string().min(1),
  threads: z.number().int().min(1).max(16).default(2),
  threshold: z.number().min(0.05).max(0.95).default(0.5),
  minSilenceMs: z.number().int().min(100).max(3000).default(500),
});
type Model = z.infer<typeof Model>;
const Config = z.object({ models: z.record(z.string(), Model).default({}) });
type Config = z.infer<typeof Config>;

const KIND: ItemKind = {
  id: "onnx",
  label: T("Modèle ONNX", "ONNX model"),
  description: T(
    "Un détecteur de parole (fichier silero_vad.onnx) ou une transcription (dossier avec encoder, decoder, joiner et tokens.txt, ex. Parakeet TDT).",
    "A speech detector (silero_vad.onnx file) or a transcription (folder with encoder, decoder, joiner and tokens.txt, e.g. Parakeet TDT)."),
  fields: [
    { key: "label", label: T("Nom", "Name"), type: "text", required: true },
    { key: "path", label: T("Fichier ou dossier du modèle", "Model file or folder"), type: "path", required: true, placeholder: T("C:/models/silero_vad.onnx", "C:/models/silero_vad.onnx") },
    { key: "threads", label: T("Fils du processeur", "CPU threads"), type: "number", default: 2, advanced: true },
    { key: "threshold", label: T("Seuil de détection (0 à 1)", "Detection threshold (0 to 1)"), type: "number", default: 0.5, advanced: true,
      hint: T("Plus haut : moins sensible au bruit. Détecteur de parole seulement.", "Higher: less sensitive to noise. Speech detector only.") },
    { key: "minSilenceMs", label: T("Silence de fin de phrase (ms)", "End-of-sentence silence (ms)"), type: "number", default: 500, advanced: true,
      hint: T("Plus court : réponse plus rapide, mais risque de couper une phrase. Détecteur de parole seulement.", "Shorter: faster reply, but may cut a sentence. Speech detector only.") },
  ],
};

/** Détecteur sherpa -> contrat `vad` : débuts et fins lus aux changements de isDetected(). */
export function vadStream(vad: ReturnType<Native["vad"]>): VadStream {
  let n = 0;
  let speaking = false;
  return {
    push(frame) {
      vad.acceptWaveform(frame);
      n += frame.length;
      const out: VadEvent[] = [];
      const now = vad.isDetected();
      if (now !== speaking) { speaking = now; out.push({ type: now ? "start" : "end", sample: n }); }
      while (!vad.isEmpty()) vad.pop(); // les segments complets ne servent pas : le plugin Écoute garde le son
      return out;
    },
    reset() { vad.reset(); n = 0; speaking = false; },
    close() { vad.reset(); },
  };
}

/** Même chemin (sans tenir compte de la casse sous un système qui l'ignore). */
const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
};

export function makePlugin(native: Native, known: KnownModel[] = KNOWN_MODELS): PluginDef<Config> {
  return definePlugin<Config>({
    manifest: {
      id: "stt-sherpa", version: "0.1.0", licence: "MIT", provides: ["vad", "stt"],
      // Téléchargement des modèles connus (voir known-models.ts).
      permissions: { net: ["github.com", "huggingface.co"] },
      description: "Lecteur sherpa-onnx : détecteur de parole Silero et transcription (Parakeet TDT…), modèles ONNX sur le processeur.",
      sections: [{ id: "ecoute", label: { fr: "Écoute", en: "Listening" } }],
      addable: {
        section: "ecoute", label: "sherpa-onnx", single: true,
        description: T("Modèles ONNX sur cet ordinateur (détecteur de parole, transcription), sans carte graphique.", "ONNX models on this computer (speech detector, transcription), no graphics card needed."),
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const store = ctx.items.store();
      const base = cfg.models as Record<string, Model>;
      const all = (): (Model & { id: string })[] => Object.entries(store.merge(base as unknown as Record<string, Record<string, unknown>>))
        .flatMap(([id, v]) => { const m = Model.safeParse(v); return m.success ? [{ ...m.data, id }] : []; });
      const enabled = () => all().filter((m) => store.isEnabled(m.id));
      const detected = new Map<string, Detected>();
      const kindOf = (m: Model): Detected => {
        let d = detected.get(m.path);
        if (!d || d.kind === "error") { d = detect(m.path); detected.set(m.path, d); }
        return d;
      };
      /** Modèles chargés en ce moment (id -> prêt). */
      const running = new Map<string, boolean>();
      const mark = (id: string, ready: boolean | undefined) => { if (ready === undefined) running.delete(id); else running.set(id, ready); ctx.items.changed(); };

      ctx.offer("vad", {
        items: () => enabled().filter((m) => kindOf(m).kind === "vad").map((m) => ({ id: m.id, label: m.label })),
        start(f, id) {
          const m = enabled().find((x) => x.id === id);
          const d = m && kindOf(m);
          if (!m || d?.kind !== "vad") throw new TextError(T(`Détecteur de parole inconnu : ${id}`, `Unknown speech detector: ${id}`));
          const config = vadConfig(d.file, m);
          native.vad(config, 60); // vérifie le modèle tout de suite (erreur visible au démarrage, pas au premier mot)
          mark(id, true);
          f.effect(() => mark(id, undefined));
          f.provide("vad", {
            name: m.label, minSilenceMs: m.minSilenceMs,
            open: () => vadStream(native.vad(config, 60)),
          } satisfies VadService);
        },
      });

      ctx.offer("stt", {
        items: () => enabled().filter((m) => kindOf(m).kind === "stt").map((m) => ({ id: m.id, label: m.label, slow: true })),
        async start(f, id) {
          const m = enabled().find((x) => x.id === id);
          const d = m && kindOf(m);
          if (!m || d?.kind !== "stt") throw new TextError(T(`Transcription inconnue : ${id}`, `Unknown transcription: ${id}`));
          mark(id, false);
          f.effect(() => mark(id, undefined));
          const t0 = Date.now();
          const rec = await native.recognizer(recognizerConfig(d, m.threads));
          f.log("info", `transcription chargée : ${m.label} (${Date.now() - t0} ms)`);
          mark(id, true);
          f.provide("stt", {
            name: m.label,
            async transcribe(audio, opts) {
              if (!f.alive) throw new TextError(T("Transcription arrêtée", "Transcription stopped"));
              opts?.signal?.throwIfAborted();
              const stream = rec.createStream();
              stream.acceptWaveform({ samples: audio, sampleRate: 16000 });
              return { text: (await rec.decodeAsync(stream)).text.trim() };
            },
          } satisfies SttService);
        },
      });

      // ---- Fenêtre des réglages : rubrique « Écoute », fournisseur « sherpa-onnx »
      const problem = (v: Model): OpResult | undefined => {
        const d = detect(v.path);
        return d.kind === "error" ? { ok: false, text: T(d.reason.fr, d.reason.en) } : undefined;
      };
      const parse = (values: Record<string, unknown>): Model | OpResult => {
        const r = Model.safeParse(values);
        return r.success ? r.data : { ok: false, text: T("Donne un nom et le chemin du modèle.", "Give a name and the model path.") };
      };
      const isResult = (x: Model | OpResult): x is OpResult => "ok" in x;
      const info = (m: Model & { id: string }): ItemInfo => {
        const d = kindOf(m);
        const on = store.isEnabled(m.id);
        const state = running.get(m.id);
        return {
          id: m.id, label: m.label, kind: KIND.id, enabled: on, active: state !== undefined,
          detail: d.kind === "vad" ? T("détecteur de parole", "speech detector") : d.kind === "stt" ? T("transcription", "transcription") : T(d.reason.fr, d.reason.en),
          status: d.kind === "error" ? "error" : !on ? "off" : state === undefined ? undefined : state ? "ok" : "loading",
          statusText: state === undefined ? undefined : state ? T("chargé", "loaded") : T("chargement…", "loading…"),
          values: { ...m } as unknown as Record<string, unknown>,
          editable: true, removable: state === undefined, toggleable: state === undefined || !on,
        };
      };
      const busy = (id: string, label: string): OpResult | undefined => running.has(id)
        ? { ok: false, text: T(`${label} sert en ce moment : choisis d'abord un autre modèle.`, `${label} is in use right now: choose another model first.`) }
        : undefined;
      ctx.items.declare({
        id: "sherpa", section: "ecoute", order: 40, offers: ["vad", "stt"],
        label: "sherpa-onnx",
        description: T("Modèles ONNX lancés dans Floppy, sur le processeur, seulement quand ils servent.", "ONNX models run inside Floppy, on the CPU, only while in use."),
        addLabel: T("Ajouter un modèle", "Add a model"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values) => {
          if (kind !== KIND.id) return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
          const v = parse(values);
          if (isResult(v)) return v;
          const no = problem(v);
          if (no) return no;
          detected.delete(v.path);
          const id = store.add(KIND.id, v as unknown as Record<string, unknown>, v.label, Object.keys(base));
          ctx.items.changed();
          return { ok: true, id, text: T(`${v.label} ajouté.`, `${v.label} added.`) };
        },
        update: async (id, values) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
          const v = parse({ ...cur, ...values });
          if (isResult(v)) return v;
          const no = problem(v);
          if (no) return no;
          detected.delete(v.path);
          store.update(id, v as unknown as Record<string, unknown>);
          ctx.items.changed();
          return { ok: true, id, text: running.has(id) ? T(`${v.label} modifié. Les changements valent au prochain chargement.`, `${v.label} updated. Changes apply on the next load.`) : T(`${v.label} modifié.`, `${v.label} updated.`) };
        },
        remove: async (id) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
          const no = busy(id, cur.label);
          if (no) return no;
          store.remove(id);
          ctx.items.changed();
          return { ok: true, text: T(`${cur.label} retiré de la liste (les fichiers ne sont pas touchés).`, `${cur.label} removed from the list (the files aren't touched).`) };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
          if (!on) { const no = busy(id, cur.label); if (no) return no; }
          store.setEnabled(id, on);
          ctx.items.changed();
          return { ok: true, text: on ? T(`${cur.label} disponible.`, `${cur.label} available.`) : T(`${cur.label} masqué (rien n'est supprimé).`, `${cur.label} hidden (nothing is deleted).`) };
        },
        test: async (_kind, values) => {
          const d = detect(String(values.path ?? ""));
          if (d.kind === "error") return { ok: false, text: T(d.reason.fr, d.reason.en) };
          return { ok: true, text: d.kind === "vad" ? T("Détecteur de parole reconnu.", "Speech detector recognized.") : T("Modèle de transcription reconnu.", "Transcription model recognized.") };
        },
      });

      // Modèles à télécharger : une fois sur le disque, ils rejoignent la liste ci-dessus (prêts à activer).
      const targetOf = (e: KnownModel) => resolve(ctx.downloads.dir, e.target);
      const mine = (e: KnownModel) => all().filter((m) => samePath(m.path, targetOf(e)));
      modelLibrary(ctx, {
        id: "sherpa-library", section: "ecoute", order: 41, offers: ["vad", "stt"],
        label: T("Modèles sherpa-onnx", "sherpa-onnx models"),
        entries: () => known,
        has: (e) => mine(e as KnownModel).length > 0,
        itemOf: (e) => mine(e as KnownModel)[0]?.id,
        installed: (e) => {
          const k = e as KnownModel;
          if (mine(k).length) return;
          const path = targetOf(k);
          detected.delete(path);
          const values: Model = { label: tr(k.label, ctx.uiLang()), path, threads: 2, threshold: 0.5, minSilenceMs: 500 };
          store.add(KIND.id, values as unknown as Record<string, unknown>, k.id, Object.keys(base));
          ctx.items.changed();
        },
        removed: (e) => {
          const list = mine(e as KnownModel);
          for (const m of list) { const no = busy(m.id, m.label); if (no) throw new TextError(no.text as { fr: string; en: string }); }
          for (const m of list) { store.remove(m.id); detected.delete(m.path); }
          ctx.items.changed();
        },
      });
    },
  });
}

export default makePlugin(realNative);
