import { z } from "zod";
import { definePlugin, providerConfig, T, TextError, type WakewordService, type WakewordStream } from "@floppy/core";

const tokens = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+/g) ?? [];
const Words = z.array(z.string().trim().min(1)).min(1).refine(words => words.some(word => tokens(word).join("").length >= 3), "Il faut au moins un mot d'au moins 3 lettres.");
const Config = z.object({ name: z.string().trim().min(1).default("Transcription locale (STT)"), words: Words.optional() });

export default definePlugin({
  manifest: {
    id: "wakeword-stt", version: "0.1.0", licence: "MIT", provides: ["wakeword"], optional: ["voice"],
    description: "Détection des mots d'activation dans les transcriptions du STT déjà actif, sans charger un autre modèle.",
    sections: [{ id: "ecoute", label: { fr: "Écoute", en: "Listening" } }],
    addable: { section: "ecoute", label: T("Transcription locale (STT)", "Local transcription (STT)"), description: T("Utilise le modèle STT du service voix déjà actif.", "Uses the STT model of the voice service already running.") },
  },
  config: Config,
  apply(ctx, cfg) {
    const voice = ctx.maybe("voice");
    const changed = new Set<() => void>(), sessions = new Set<WakewordStream>();
    // Migration du réglage qui appartenait auparavant à conversation ; le nouveau catalogue est prioritaire.
    const legacy = ctx.settings.saved<string>("mot_activation");
    const base = { ...cfg, words: cfg.words ?? (legacy ? legacy.split(/[,;]/).map(w => w.trim()).filter(Boolean) : [...ctx.assistant.wake_words]) };
    const account = providerConfig(ctx, {
      schema: Config.extend({ words: Words }), base, label: `Transcription STT — ${ctx.id}`, section: "ecoute", offers: "wakeword", secret: false,
      fields: [{ key: "name", label: T("Nom dans le sélecteur", "Name in the picker"), type: "text", required: true }, { key: "words", label: T("Mots et variantes d'activation", "Wake words and variants"), type: "list", required: true, hint: T("Ex. floppy, flopy, floppie. La phrase doit être transcrite avant la détection.", "E.g. floppy, flopy, floppie. The phrase must be transcribed before detection.") }],
      validate: () => voice ? undefined : T("Le plugin STT nécessite un service voix actif pour produire les transcriptions.", "The STT plugin needs an active voice service to produce transcripts."),
      onChange: () => { for (const fn of [...changed]) fn(); },
    });
    ctx.effect(() => { for (const stream of [...sessions]) stream.close(); changed.clear(); });
    const service: WakewordService = {
      get name() { return account.config().name; }, input: "transcript", words: () => [...account.config().words],
      availability: account.availability,
      onChange(fn) { changed.add(fn); return () => { changed.delete(fn); }; },
      async open(opts) {
        opts.signal.throwIfAborted();
        const available = account.availability();
        if (!available.ready) throw new TextError(available.reasonText ?? available.reason ?? "");
        let closed = !ctx.alive;
        const stream: WakewordStream = {
          pushAudio() {},
          pushTranscript(input) {
            if (closed || opts.signal.aborted) return;
            const text = tokens(input.text);
            for (const word of account.config().words) {
              const target = tokens(word);
              if (!target.length || !text.some((_, i) => target.every((token, j) => token === text[i + j]))) continue;
              opts.onDetection({ word, startSample: input.startSample, endSample: input.endSample });
              return;
            }
          },
          close() { closed = true; sessions.delete(stream); opts.signal.removeEventListener("abort", stream.close); },
        };
        sessions.add(stream); opts.signal.addEventListener("abort", stream.close, { once: true });
        if (closed || opts.signal.aborted) stream.close();
        return stream;
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
