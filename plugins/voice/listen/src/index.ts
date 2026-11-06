// Plugin `voice-listen` (« Écoute ») : fournit le service `voice` en assemblant deux plugins choisis dans les réglages,
// le détecteur de parole (slot listen.vad) et la transcription (slot listen.stt). Il ne parle pas : la voix passe par `tts`.
// - Les modèles sont empruntés (ctx.borrow) à l'ouverture du premier flux et rendus à la fermeture du dernier.
// - Un flux par corps (son propre détecteur) ; la transcription est partagée, une demande à la fois.
// - Les règles d'écoute (interruption, recollage, bouton, dictée) sont dans stream.ts, reprises du service Python.
import { definePlugin, T, TextError, type SttService, type VadService, type VoiceService } from "@floppy/core";
import { ListenStream } from "./stream.ts";

export { ListenStream } from "./stream.ts";

type Borrowed<T> = { service: T; release(): void };

export default definePlugin({
  manifest: {
    id: "voice-listen", version: "0.1.0", licence: "MIT", provides: ["voice"],
    description: "Écoute assemblée : détecteur de parole (vad) + transcription (stt), choisis dans des slots ; règles d'écoute en TypeScript.",
    sections: [{ id: "ecoute", label: { fr: "Écoute", en: "Listening" } }],
    slots: [
      { id: "listen.vad", service: "vad", section: "ecoute", label: T("Détecteur de parole", "Speech detector"),
        description: T("Repère quand tu commences et quand tu finis de parler.", "Notices when you start and stop speaking.") },
      { id: "listen.stt", service: "stt", section: "ecoute", label: T("Transcription", "Transcription"),
        description: T("Transforme ce que tu dis en texte.", "Turns what you say into text.") },
    ],
    addable: {
      section: "ecoute", label: T("Écoute", "Listening"), single: true,
      description: T("Détecteur de parole et transcription au choix, sur cet ordinateur.", "Your choice of speech detector and transcription, on this computer."),
    },
  },
  apply(ctx) {
    let held: Promise<{ vad: Borrowed<VadService>; stt: Borrowed<SttService> }> | undefined;
    let users = 0;
    /** File unique de transcription : une demande à la fois, tous corps confondus. */
    let sttQueue: Promise<unknown> = Promise.resolve();

    const acquire = () => {
      users++;
      held ??= (async () => {
        const vad = await ctx.borrow<VadService>("listen.vad");
        const stt = await ctx.borrow<SttService>("listen.stt");
        if (!vad || !stt) {
          vad?.release(); stt?.release();
          throw new TextError(!vad
            ? T("Aucun détecteur de parole en service. Ajoute-en un dans Réglages → Écoute.", "No speech detector in use. Add one in Settings → Listening.")
            : T("Aucune transcription en service. Ajoute-en une dans Réglages → Écoute.", "No transcription in use. Add one in Settings → Listening."));
        }
        ctx.log("info", `écoute : ${vad.service.name} + ${stt.service.name}`);
        return { vad, stt };
      })();
      const mine = held;
      return mine.catch((e: unknown) => { users--; if (held === mine) held = undefined; throw e; });
    };
    const release = () => {
      users--;
      if (users > 0 || !held) return;
      const h = held;
      held = undefined;
      void h.then(({ vad, stt }) => { vad.release(); stt.release(); }, () => {});
    };
    ctx.effect(() => { if (held) void held.then(({ vad, stt }) => { vad.release(); stt.release(); }, () => {}); held = undefined; });

    const service: VoiceService = {
      name: "écoute",
      async open() {
        const { vad, stt } = await acquire();
        const language = ctx.assistant.language;
        let closed = false;
        return new ListenStream({
          vad: vad.service.open(),
          minSilenceMs: vad.service.minSilenceMs,
          transcribe: (audio) => {
            const run = sttQueue.then(() => stt.service.transcribe(audio, { language }));
            sttQueue = run.catch(() => {});
            return run.then((r) => r.text.trim());
          },
          log: (msg) => ctx.log("warn", msg),
          onClose: () => { if (!closed) { closed = true; release(); } },
        });
      },
    };
    ctx.provide("voice", service);
  },
});
