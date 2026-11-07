import { T, tr, errorText, type Text } from "@floppy/core";
import type { TtsService, VoiceEvent, VoiceStream, SpeechDelivery } from "@floppy/contracts";
import { encodeAudioOut } from "@floppy/protocol";

interface Options {
  stream: VoiceStream;
  /** Voix en service. Locale (viaStream) ou absente : le flux voix parle lui-même. */
  tts?: TtsService;
  emit(event: VoiceEvent): void;
  /** Voix choisie indisponible : erreur montrée au corps à chaque phrase. */
  unavailable?: Text;
  /** Aucune voix choisie (réponses écrites) : chaque phrase finit tout de suite, sans son ni erreur. */
  mute?: boolean;
  /** Langue des erreurs montrées au corps (celle de l'interface). Défaut : français. */
  lang?: () => string;
}

/** File par corps. Chaque phrase distante se termine exactement une fois, même annulée. */
export class SpeechQueue {
  private abort = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, AbortSignal>();
  private readonly opts: Options;
  constructor(opts: Options) { this.opts = opts; }
  speak(id: string, text: string, delivery?: SpeechDelivery): void {
    const { stream, tts, emit, unavailable } = this.opts;
    const lang = this.opts.lang?.() ?? "fr";
    if (this.opts.mute) { emit({ type: "speak_done", id, cancelled: false }); return; }
    if (unavailable) { emit({ type: "speak_done", id, cancelled: true, error: tr(unavailable, lang) }); return; }
    if (!tts?.speak || tts.viaStream) {
      if (stream.speak) { stream.speak(id, text); return; }
      // Écoute seule (plugin Écoute) : la voix doit venir d'un plugin tts qui parle lui-même.
      const why = tts?.viaStream
        ? T("Cette voix a besoin de la « Voix locale ». Choisis une autre voix dans les réglages.", "This voice needs the “Local voice”. Choose another voice in the settings.")
        : T("Aucune voix en service. Active une voix dans les réglages.", "No voice in use. Turn on a voice in the settings.");
      emit({ type: "speak_done", id, cancelled: true, error: tr(why, lang) });
      return;
    }
    const speakWith = tts.speak.bind(tts);
    const signal = this.abort.signal;
    this.pending.set(id, signal);
    this.tail = this.tail.then(async () => {
      if (signal.aborted) return;
      let error: string | undefined;
      try {
        emit({ type: "audio_start", id });
        for await (const chunk of speakWith(text, { signal, ...(delivery ? { delivery } : {}) })) {
          if (signal.aborted) break;
          emit({ type: "audio", id, data: encodeAudioOut(chunk.pcm, chunk.rate) });
        }
      } catch (e) { if (!signal.aborted) error = e instanceof Error ? tr(errorText(e), lang) : tr(T("Erreur de synthèse vocale", "Speech synthesis error"), lang); }
      finally {
        if (this.pending.get(id) === signal) {
          this.pending.delete(id);
          emit({ type: "speak_done", id, cancelled: signal.aborted, error });
        }
      }
    });
  }
  cancel(): void {
    this.abort.abort(); this.abort = new AbortController();
    this.tail = Promise.resolve();
    const ids = [...this.pending.keys()]; this.pending.clear();
    this.opts.stream.cancel();
    for (const id of ids) this.opts.emit({ type: "speak_done", id, cancelled: true });
  }
}
