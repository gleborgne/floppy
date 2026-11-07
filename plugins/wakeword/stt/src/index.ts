import { z } from "zod";
import { definePlugin, providerConfig, T, TextError, tr, type WakewordService, type WakewordStream } from "@floppy/core";

const tokens = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? [];
const Words = z.array(z.string().trim().min(1)).min(1).refine(words => words.some(word => tokens(word).join("").length >= 3), "Il faut au moins un mot d'au moins 3 lettres.");
// Nom vide : le nom par défaut, dans la langue de l'interface.
const Config = z.object({ name: z.string().trim().default(""), words: Words.optional() });
const DEFAULT_NAME = T("Dans le texte transcrit", "In the transcribed text");
const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const short = (text: string) => { const s = text.trim().replace(/\s+/g, " "); return s.length > 80 ? `${s.slice(0, 79)}…` : s; };

export default definePlugin({
  manifest: {
    id: "wakeword-stt", version: "0.1.0", licence: "MIT", provides: ["wakeword"], optional: ["voice"],
    description: "Détection des mots d'activation dans les transcriptions du STT déjà actif, sans charger un autre modèle.",
    sections: [{ id: "ecoute", label: { fr: "Écoute", en: "Listening" } }],
    addable: { section: "ecoute", label: DEFAULT_NAME, description: T("Cherche les mots d'activation dans chaque phrase transcrite, sans charger d'autre modèle.", "Looks for the wake words in each transcribed sentence, without loading another model.") },
  },
  config: Config,
  apply(ctx, cfg) {
    const voice = ctx.maybe("voice");
    const changed = new Set<() => void>(), sessions = new Set<WakewordStream>();
    // Dernier réveil : montré dans les réglages, pour voir quelle variante a marché. Gardé en mémoire seulement.
    let lastWake: { text: string; at: number } | undefined;
    // Migration du réglage qui appartenait auparavant à conversation ; le nouveau catalogue est prioritaire.
    const legacy = ctx.settings.saved<string>("mot_activation");
    const base = { ...cfg, words: cfg.words ?? (legacy ? legacy.split(/[,;]/).map(w => w.trim()).filter(Boolean) : [...ctx.assistant.wake_words]) };
    const account = providerConfig(ctx, {
      schema: Config.extend({ words: Words }), base, label: T("Mots d'activation", "Wake words"), section: "ecoute", offers: "wakeword", secret: false,
      fields: [
        { key: "words", label: T("Floppy se réveille s'il entend un de ces mots", "Floppy wakes up when it hears one of these words"), type: "list", required: true, hint: T("Ajoute les façons dont la transcription écrit mal le nom (ex. flopy, floppie). Un mot d'au moins 3 lettres.", "Add the ways the transcription misspells the name (e.g. flopy, floppie). One word of at least 3 letters.") },
        { key: "name", label: T("Nom dans la liste des plugins", "Name in the plugin list"), type: "text", advanced: true, placeholder: DEFAULT_NAME },
      ],
      validate: () => voice ? undefined : T("Le plugin STT nécessite un service voix actif pour produire les transcriptions.", "The STT plugin needs an active voice service to produce transcripts."),
      detail: () => lastWake && T(`Dernier réveil : « ${lastWake.text} » à ${hhmm(lastWake.at)}`, `Last wake: “${lastWake.text}” at ${hhmm(lastWake.at)}`),
      onChange: () => { for (const fn of [...changed]) fn(); },
    });
    const nameOf = () => account.config().name || DEFAULT_NAME;
    ctx.effect(() => { for (const stream of [...sessions]) stream.close(); changed.clear(); });
    const service: WakewordService = {
      get name() { return tr(nameOf(), ctx.assistant.language); }, input: "transcript", words: () => [...account.config().words],
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
              lastWake = { text: short(input.text), at: Date.now() };
              ctx.items.changed();
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
      items: () => [{ id: "account", label: nameOf() }],
      start(f) {
        // Comme avant (sélecteur exclusif) : un détecteur pas configuré ne peut pas être choisi.
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Détecteur non configuré", "Detector not configured"));
        f.provide("wakeword", service);
      },
    });
  },
});
