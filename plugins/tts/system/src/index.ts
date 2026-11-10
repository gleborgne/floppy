// Plugin `tts-system` : les voix déjà installées dans le système (Windows, macOS, Linux). Gratuit, hors ligne, rien à télécharger.
// - Au démarrage, le plugin demande la liste des voix au système, et offre le service `tts` voix par voix (slot voice.tts).
// - La voix choisie tourne dans un fork : sous Windows, un PowerShell gardé ouvert, fermé avec le fork.
// - Le système rend une phrase entière en WAV (pas de flux) : on la découpe en morceaux de 100 ms pour la lecture.
import { z } from "zod";
import { definePlugin, T, TextError, wavPcm, type OfferItem } from "@floppy/core";
import { type TtsChunk, type TtsService } from "@floppy/contracts";
import { emotionNote } from "@floppy/toolkit";
import { engineFor, type SystemVoice } from "./engines.ts";

export { engineFor, parseEspeakVoices, parseSayVoices, parseWindowsVoices } from "./engines.ts";

const Config = z.object({
  /** Langues montrées (« fr », « en-GB »…). Vide : la langue de l'assistant et l'anglais. */
  languages: z.array(z.string().min(2)).default([]),
});
type Config = z.infer<typeof Config>;

/** Id d'élément sans caractère gênant pour une clé « entrée/service/élément ». */
export const itemId = (voiceId: string) => voiceId.replace(/[^A-Za-z0-9_.-]+/g, "-");

/** Le prénom de la voix, pour la choisir à l'oral : « Microsoft Julie » -> « julie ». */
export function alias(name: string): string {
  return name.replace(/\(.*?\)/g, "").replace(/^Microsoft\s+/i, "").replace(/\s+(Desktop|Online)$/i, "").trim().toLowerCase();
}

/** Garde les voix des langues voulues ; si aucune ne correspond, les garde toutes. Langue de l'assistant d'abord. */
export function pickVoices(all: SystemVoice[], languages: string[]): SystemVoice[] {
  const wanted = languages.map((l) => l.toLowerCase());
  const rank = (v: SystemVoice) => {
    const lang = v.lang.toLowerCase();
    return wanted.findIndex((l) => lang === l || lang.startsWith(`${l}-`));
  };
  const kept = all.filter((v) => rank(v) >= 0);
  return (kept.length ? kept : all).slice().sort((a, b) => rank(a) - rank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

/** Découpe le PCM en morceaux de 100 ms : la lecture commence et s'interrompt finement. */
export function* chunks(rate: number, pcm: Int16Array): Generator<TtsChunk> {
  const step = Math.max(1, Math.round(rate / 10));
  for (let i = 0; i < pcm.length; i += step) yield { rate, pcm: pcm.subarray(i, i + step) };
}

export default definePlugin<Config>({
  manifest: {
    id: "tts-system", version: "0.1.0", licence: "MIT", provides: ["tts"],
    description: T("Voix déjà installées sur l'ordinateur, par le programme de synthèse vocale du système.", "Voices already installed on the computer, through the system's speech program."),
    sections: [{ id: "voix", label: { fr: "Voix", en: "Voice" } }],
    permissions: { exec: ["powershell", "say", "espeak-ng"] },
    addable: {
      section: "voix", label: T("Voix du système", "System voices"), single: true,
      description: T("Les voix déjà installées sur cet ordinateur. Gratuit et hors ligne, mais moins naturel.", "Voices already installed on this computer. Free and offline, but less natural."),
    },
  },
  config: Config,
  async apply(ctx, cfg) {
    const engine = engineFor(process.platform);
    let voices: SystemVoice[] = [];
    if (!engine) {
      ctx.items.status(T("Pas de voix intégrée sur cet ordinateur", "No built-in voices on this computer"), "warn");
    } else {
      try {
        const languages = cfg.languages.length ? cfg.languages : [...new Set([ctx.assistant.language, "en"])];
        voices = pickVoices(await engine.voices(ctx.spawn), languages);
        ctx.items.status(voices.length ? T(`${voices.length} voix`, `${voices.length} voices`) : T("Aucune voix installée", "No voice installed"), voices.length ? "ok" : "warn");
      } catch (e) {
        ctx.log("warn", `liste des voix impossible (${engine.label}, ${engine.missing}) : ${(e as Error).message}`);
        ctx.items.status(T("Voix du système illisibles : le programme de synthèse vocale est-il installé ?", "Cannot read the system voices: is the speech program installed?"), "error");
      }
    }
    const byItem = new Map(voices.map((v) => [itemId(v.id), v]));
    const items: OfferItem[] = [...byItem].map(([id, v]) => ({ id, label: `${v.name} (${v.lang})`, note: emotionNote(false), ...(alias(v.name) ? { aliases: [alias(v.name)] } : {}) }));

    ctx.offer("tts", {
      items: () => items,
      start(f, id) {
        const voice = byItem.get(id);
        if (!engine || !voice) throw new TextError(T(`Voix du système introuvable : ${id}`, `System voice not found: ${id}`));
        const speaker = engine.open(f.spawn);
        f.effect(() => speaker.close());
        const service: TtsService = {
          name: `${voice.name} (${ctx.uiLang() === "en" ? "system" : "système"})`,
          async *speak(text, opts) {
            if (!f.alive) throw new TextError(T("Voix du système arrêtée", "System voice stopped"));
            if (!text.trim()) return;
            const wav = await speaker.synth(voice.id, text, AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]));
            opts.signal.throwIfAborted();
            const { rate, pcm } = wavPcm(wav);
            for (const c of chunks(rate, pcm)) { opts.signal.throwIfAborted(); yield c; }
          },
        };
        f.provide("tts", service);
      },
    });
  },
});
