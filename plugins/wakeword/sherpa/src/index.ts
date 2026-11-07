import { statSync } from "node:fs";
import { z } from "zod";
import { definePlugin, providerConfig, T, TextError, tr } from "@floppy/core";
import type { WakewordService, WakewordStream } from "@floppy/contracts";
import { createSpotter, type SherpaStream, type SherpaSpotter } from "./native.ts";

const Config = z.object({
  name: z.string().trim().min(1).default("Sherpa ONNX"),
  encoder: z.string().default(""), decoder: z.string().default(""), joiner: z.string().default(""),
  tokens: z.string().default(""), keywordsFile: z.string().default(""),
  threshold: z.number().min(0).max(1).default(0.25), score: z.number().min(0).max(10).default(1),
  threads: z.number().int().min(1).max(8).default(1),
  preRollMs: z.number().int().min(250).max(5000).default(1500), cooldownMs: z.number().int().min(250).max(10000).default(1500),
});
const file = (path: string) => { try { return !!path && statSync(path).isFile(); } catch { return false; } };

export default definePlugin({
  manifest: {
    id: "wakeword-sherpa", version: "0.1.0", licence: "MIT", provides: ["wakeword"],
    description: "Détection de mots d'activation locale sur CPU avec Sherpa ONNX.",
    sections: [{ id: "ecoute", label: { fr: "Écoute", en: "Listening" } }],
    addable: { section: "ecoute", label: "Sherpa ONNX", description: T("Moteur CPU sans clé ; modèles ONNX et fichier de mots requis.", "CPU engine, no key; ONNX models and a keywords file required.") },
  },
  config: Config,
  apply(ctx, cfg) {
    const changed = new Set<() => void>(), sessions = new Set<WakewordStream>();
    const lifetime = new AbortController();
    const account = providerConfig(ctx, {
      schema: Config, base: cfg, label: `Sherpa ONNX — ${ctx.id}`, section: "ecoute", offers: "wakeword", secret: false,
      onChange: () => { for (const fn of [...changed]) fn(); },
      validate: c => {
        for (const key of ["encoder", "decoder", "joiner", "tokens", "keywordsFile"] as const) if (!file(c[key])) return T(`Sherpa : fichier ${key} absent. Configure ce plugin dans Écoute.`, `Sherpa: ${key} file missing. Configure this plugin in Listening.`);
      },
      fields: [
        { key: "name", label: T("Nom dans le sélecteur", "Name in the picker"), type: "text", required: true },
        ...["encoder", "decoder", "joiner"].map(key => ({ key, label: T(`Modèle ${key} (ONNX)`, `${key} model (ONNX)`), type: "path" as const, required: true })),
        { key: "tokens", label: T("Fichier tokens.txt", "tokens.txt file"), type: "path", required: true },
        { key: "keywordsFile", label: T("Fichier de mots tokenisés (keywords.txt)", "Tokenized keywords file (keywords.txt)"), type: "path", required: true, hint: T("Les mots et leur tokenisation doivent correspondre au modèle Sherpa choisi.", "The words and their tokenization must match the chosen Sherpa model.") },
        { key: "threshold", label: T("Seuil de détection", "Detection threshold"), type: "number", min: 0, max: 1 },
        { key: "score", label: T("Renforcement des mots", "Keyword boost"), type: "number", min: 0, max: 10, advanced: true },
        { key: "threads", label: T("Threads CPU", "CPU threads"), type: "number", min: 1, max: 8, advanced: true },
        { key: "preRollMs", label: T("Audio conservé avant détection (ms)", "Audio kept before detection (ms)"), type: "number", min: 250, max: 5000, advanced: true },
        { key: "cooldownMs", label: T("Délai entre détections (ms)", "Delay between detections (ms)"), type: "number", min: 250, max: 10000, advanced: true },
      ],
    });
    ctx.effect(() => { lifetime.abort(); for (const session of [...sessions]) session.close(); changed.clear(); });
    const service: WakewordService = {
      get name() { return account.config().name; }, availability: account.availability,
      onChange(fn) { changed.add(fn); return () => { changed.delete(fn); }; },
      async open(opts) {
        const signal = AbortSignal.any([opts.signal, lifetime.signal]);
        signal.throwIfAborted();
        const available = account.availability();
        if (!available.ready) throw new TextError(available.reasonText ?? available.reason ?? "");
        const c = account.config();
        let engine: SherpaSpotter | undefined;
        try {
          engine = createSpotter({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
            transducer: { encoder: c.encoder, decoder: c.decoder, joiner: c.joiner }, tokens: c.tokens, numThreads: c.threads, provider: "cpu", debug: 0,
          }, keywordsFile: c.keywordsFile, keywordsThreshold: c.threshold, keywordsScore: c.score });
        } catch { throw new TextError(T("Sherpa : impossible de charger le moteur ou ses modèles ONNX. Vérifie leur compatibilité.", "Sherpa: can't load the engine or its ONNX models. Check their compatibility.")); }
        let native: SherpaStream | undefined = engine.createStream();
        let next: number | undefined, last = -Infinity;
        const session: WakewordStream = {
          pushAudio(frame, start) {
            if (!engine || !native || !frame.length) return;
            try {
              if (next !== undefined && start !== next) { native = engine.createStream(); last = -Infinity; }
              next = start + frame.length;
              native.acceptWaveform({ samples: frame, sampleRate: 16000 });
              while (engine.isReady(native)) {
                engine.decode(native);
                const word = engine.getResult(native).keyword;
                if (!word) continue;
                engine.reset(native);
                if (next - last < c.cooldownMs * 16) continue;
                last = next;
                opts.onDetection({ word, startSample: Math.max(0, next - c.preRollMs * 16), endSample: next });
                if (!engine || !native) return; // le consommateur peut fermer pendant le rappel
              }
            } catch { session.close(); opts.onError(tr(T("Sherpa : erreur de détection locale. Vérifie les modèles du plugin.", "Sherpa: local detection error. Check the plugin's models."), ctx.assistant.language)); }
          },
          close() { if (!engine) return; engine = undefined; native = undefined; sessions.delete(session); signal.removeEventListener("abort", session.close); },
        };
        sessions.add(session); signal.addEventListener("abort", session.close, { once: true });
        if (!ctx.alive || signal.aborted) session.close();
        return session;
      },
    };
    // Le détecteur est offert (slot listen.wakeword) : il tourne seulement s'il est choisi et que la conversation tourne.
    ctx.offer("wakeword", {
      items: () => [{ id: "account", label: account.config().name }],
      start(f) {
        // Comme avant (sélecteur exclusif) : un détecteur pas configuré ne peut pas être choisi.
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Détecteur non configuré", "Detector not configured"));
        f.provide("wakeword", service);
      },
    });
  },
});
