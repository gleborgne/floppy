// Plugin `voice-listen` (« Écoute ») : fournit le service `voice` en assemblant deux plugins choisis dans les réglages,
// le détecteur de parole (slot listen.vad) et la transcription (slot listen.stt). Il ne parle pas : la voix passe par `tts`.
// - Les modèles sont empruntés (ctx.borrow) à l'ouverture du premier flux et rendus à la fermeture du dernier.
// - Un flux par corps (son propre détecteur) ; la transcription est partagée, une demande à la fois.
// - Les règles d'écoute (interruption, recollage, bouton, dictée) sont dans stream.ts, reprises du service Python.
import { definePlugin, T, TextError, type Borrowed } from "@floppy/core";
import type { SttService, VadService, VadStream, VoiceService } from "@floppy/contracts";
import { HOLD_INCOMPLETE_MS, ListenStream } from "./stream.ts";

export { ListenStream, looksUnfinished } from "./stream.ts";

export default definePlugin({
  manifest: {
    id: "voice-listen", version: "0.1.0", licence: "MIT", provides: ["voice"],
    description: "Écoute assemblée : détecteur de parole (vad) + transcription (stt), choisis dans des slots ; règles d'écoute en TypeScript.",
    sections: [{ id: "listening", label: { fr: "Écoute", en: "Listening" } }],
    slots: [
      { id: "listen.vad", service: "vad", section: "listening", label: T("Détecteur de parole", "Speech detector"), step: 1,
        description: T("Repère quand tu commences et quand tu finis de parler.", "Notices when you start and stop speaking.") },
      { id: "listen.stt", service: "stt", section: "listening", label: T("Transcription", "Transcription"), step: 2,
        description: T("Transforme ce que tu dis en texte.", "Turns what you say into text.") },
    ],
    addable: {
      section: "listening", label: T("Écoute", "Listening"), single: true,
      description: T("Détecteur de parole et transcription au choix, sur cet ordinateur.", "Your choice of speech detector and transcription, on this computer."),
    },
  },
  apply(ctx) {
    let held: Promise<{ vad: Borrowed<VadService>; stt: Borrowed<SttService> }> | undefined;
    let users = 0;
    /** Flux ouverts : chacun reprend le détecteur de parole en service après un nouvel emprunt. */
    const followers = new Set<() => void>();
    /** File unique de transcription : une demande à la fois, tous corps confondus. */
    let sttQueue: Promise<unknown> = Promise.resolve();

    const borrowBoth = (): NonNullable<typeof held> => {
      const mine: NonNullable<typeof held> = (async () => {
        const vad = await ctx.borrow<VadService>("listen.vad");
        const stt = await ctx.borrow<SttService>("listen.stt");
        if (!vad || !stt) {
          vad?.release(); stt?.release();
          throw new TextError(!vad
            ? T("Aucun détecteur de parole en service. Ajoute-en un dans Réglages → Écoute.", "No speech detector in use. Add one in Settings → Listening.")
            : T("Aucune transcription en service. Ajoute-en une dans Réglages → Écoute.", "No transcription in use. Add one in Settings → Listening."));
        }
        ctx.log("info", `écoute : ${vad.service.name} + ${stt.service.name}`);
        // Un des deux modèles s'arrête (panne, nouveau choix) : on rend l'autre et on réemprunte les deux pour les flux ouverts.
        void Promise.race([vad.lost, stt.lost]).then(() => {
          vad.release(); stt.release();
          if (held !== mine || !ctx.alive) return;
          ctx.log("warn", "écoute : un modèle s'est arrêté, nouvel emprunt");
          held = users > 0 ? borrowBoth() : undefined;
          // Les flux ouverts passent tout de suite au nouveau détecteur de parole.
          held?.then(() => { for (const f of [...followers]) f(); }, (e: unknown) => ctx.log("warn", `écoute : nouvel emprunt impossible : ${String(e)}`));
        });
        return { vad, stt };
      })();
      return mine;
    };
    const acquire = () => {
      users++;
      held ??= borrowBoth();
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

    // Attente d'une phrase qui a l'air inachevée (« envoie ça à… euh »), relue à chaque phrase.
    let holdMs = ctx.settings.saved<number>("hold_incomplete_ms") ?? HOLD_INCOMPLETE_MS;
    ctx.settings.declare([{
      key: "hold_incomplete_ms", section: "listening", type: "number", min: 0, max: 3000, risk: "free",
      label: T("Attente si la phrase semble inachevée", "Wait when a sentence seems unfinished"),
      group: T("Écoute", "Listening"),
      description: T(
        "Millisecondes pendant lesquelles Floppy attend avant d'envoyer une phrase qui finit sur une hésitation ou un mot de liaison (« euh », « et », « à… »). Si tu reprends, la phrase est recollée sans réponse prématurée. 0 : désactivé.",
        "Milliseconds Floppy waits before sending a sentence that ends on a hesitation or a linking word (“uh”, “and”, “to…”). If you carry on, the sentence is joined with no premature reply. 0: off."),
      get: () => holdMs, set: (v) => { const n = Number(v); holdMs = Number.isFinite(n) ? Math.max(0, Math.min(3000, Math.round(n))) : HOLD_INCOMPLETE_MS; },
    }]);

    const service: VoiceService = {
      name: "écoute",
      async open() {
        const { vad, stt } = await acquire();
        const language = ctx.assistant.language;
        let closed = false;
        // Le détecteur de parole de ce flux suit celui en service : après une panne, l'écoute le réemprunte
        // et ce flux ouvre le nouveau (sinon il n'entendrait plus jamais le début d'une phrase).
        let curVad = vad;
        let vadStream = vad.service.open();
        const follow = () => {
          void held?.then(({ vad: v }) => {
            if (closed || v === curVad) return;
            try { vadStream.close(); } catch { /* déjà fermé */ }
            curVad = v;
            vadStream = v.service.open();
          }, () => {});
        };
        followers.add(follow);
        const proxy: VadStream = {
          push: (f) => vadStream.push(f),
          reset: () => vadStream.reset(),
          close: () => { followers.delete(follow); vadStream.close(); },
        };
        return new ListenStream({
          vad: proxy,
          minSilenceMs: vad.service.minSilenceMs,
          holdIncompleteMs: () => holdMs,
          transcribe: (audio) => {
            // La transcription en service au moment de la demande (elle a pu être réempruntée après une panne).
            const run = sttQueue.then(async () => ((held ? (await held).stt : stt).service.transcribe(audio, { language })));
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
