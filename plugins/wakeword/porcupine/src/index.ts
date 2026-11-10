import { statSync } from "node:fs";
import { z } from "zod";
import { definePlugin, providerConfig, T, TextError, tr } from "@floppy/core";
import type { WakewordService, WakewordStream } from "@floppy/contracts";

const Config = z.object({
  name: z.string().trim().min(1).default("Porcupine"),
  word: z.string().min(1).default("Floppy"), keywordPath: z.string().default(""), modelPath: z.string().default(""),
  sensitivity: z.number().min(0).max(1).default(0.5),
  preRollMs: z.number().int().min(250).max(5000).default(1500), cooldownMs: z.number().int().min(250).max(10000).default(1500),
});
const file = (path: string) => { try { return !!path && statSync(path).isFile(); } catch { return false; } };

export default definePlugin({
  manifest: {
    id: "wakeword-porcupine", version: "0.1.0", licence: "MIT", provides: ["wakeword"],
    description: "Détection locale Porcupine avec un modèle de mot personnalisé et une AccessKey Picovoice.",
    sections: [{ id: "listening", label: { fr: "Écoute", en: "Listening" } }],
    permissions: { cloud: true },
    addable: { section: "listening", label: "Porcupine", cloud: true, description: T("Détection CPU locale ; activation Picovoice par clé, modèle .ppn et paramètres .pv requis.", "Local CPU detection; Picovoice activation by key, .ppn model and .pv parameters required.") },
  },
  config: Config,
  apply(ctx, cfg) {
    const changed = new Set<() => void>(), sessions = new Set<WakewordStream>();
    const lifetime = new AbortController();
    const account = providerConfig(ctx, {
      schema: Config, base: cfg, label: `Porcupine — ${ctx.id}`, section: "listening", offers: "wakeword", secretLabel: T("AccessKey Picovoice", "Picovoice AccessKey"),
      onChange: () => { for (const fn of [...changed]) fn(); },
      validate: c => !file(c.keywordPath) ? T("Porcupine : modèle de mot .ppn absent.", "Porcupine: .ppn keyword model missing.") : !file(c.modelPath) ? T("Porcupine : paramètres de langue .pv absents.", "Porcupine: .pv language parameters missing.") : undefined,
      fields: [
        { key: "name", label: T("Nom dans le sélecteur", "Name in the picker"), type: "text", required: true },
        { key: "word", label: T("Nom du mot (étiquette du modèle)", "Word name (model label)"), type: "text", required: true, hint: T("Changer ce nom ne réentraîne pas le modèle .ppn.", "Changing this name doesn't retrain the .ppn model.") },
        { key: "keywordPath", label: T("Modèle personnalisé .ppn (plateforme courante)", "Custom .ppn model (current platform)"), type: "path", required: true },
        { key: "modelPath", label: T("Paramètres de langue .pv", "Language parameters .pv"), type: "path", required: true,
          hint: T("Même langue que le modèle .ppn (ex. porcupine_params_fr.pv pour le français, porcupine_params.pv pour l'anglais).", "Same language as the .ppn model (e.g. porcupine_params.pv for English, porcupine_params_fr.pv for French).") },
        { key: "sensitivity", label: T("Sensibilité", "Sensitivity"), type: "number", min: 0, max: 1 },
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
        let engine: import("@picovoice/porcupine-node").Porcupine | undefined;
        try {
          const { Porcupine } = await import("@picovoice/porcupine-node");
          signal.throwIfAborted();
          engine = new Porcupine(account.apiKey(), [c.keywordPath], [c.sensitivity], { modelPath: c.modelPath, device: "cpu" });
          if (engine.sampleRate !== 16000 || !Number.isSafeInteger(engine.frameLength) || engine.frameLength <= 0) { engine.release(); engine = undefined; throw new Error("audio format"); }
        } catch { throw new TextError(T("Porcupine : initialisation refusée. Vérifie l'AccessKey, la langue et la plateforme des modèles.", "Porcupine: initialization refused. Check the AccessKey, and the language and platform of the models.")); }
        const length = engine.frameLength;
        let pending = new Int16Array(length), filled = 0, next: number | undefined, last = -Infinity;
        const session: WakewordStream = {
          pushAudio(frame, start) {
            if (!engine || !frame.length) return;
            if (next !== undefined && start !== next) filled = 0;
            next = start + frame.length;
            try {
              for (let i = 0; i < frame.length; i++) {
                pending[filled++] = Math.round(Math.max(-1, Math.min(1, frame[i]!)) * 32767);
                if (filled !== length) continue;
                const end = start + i + 1;
                filled = 0;
                if (engine.process(pending) < 0 || end - last < c.cooldownMs * 16) continue;
                last = end;
                opts.onDetection({ word: c.word, startSample: Math.max(0, end - c.preRollMs * 16), endSample: end });
                if (!engine) return;
              }
            } catch { session.close(); opts.onError(tr(T("Porcupine : erreur de détection locale. Vérifie la configuration du plugin.", "Porcupine: local detection error. Check the plugin's configuration."), ctx.assistant.language)); }
          },
          close() {
            if (!engine) return;
            const old = engine; engine = undefined; pending = new Int16Array(0); sessions.delete(session);
            signal.removeEventListener("abort", session.close); old.release();
          },
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
