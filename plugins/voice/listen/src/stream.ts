// Flux d'écoute d'un corps : règles reprises du service Python (services/voice/server.py), à l'identique.
// Le détecteur de parole (VadStream) et la transcription (fonction `transcribe`) sont fournis de l'extérieur.
import type { VadStream, VoiceEvent, VoiceStream } from "@floppy/contracts";

export const SR = 16000;
/** Trame du détecteur : 512 échantillons = 32 ms. */
export const FRAME = 512;
const FRAME_MS = 32;
/** Trames gardées avant le début de la parole (le début d'un mot arrive avant la détection). */
const PREROLL = 10;
export const MIN_UTTERANCE_S = 0.3;
export const BARGE_IN_MS = 300;
export const MERGE_GAP_MS = 2000;
export const DICTATE_PARTIAL_S = 0.6;
export const DICTATE_MAX_S = 30;
/** Attente par défaut d'une phrase qui a l'air inachevée (réglage `hold_incomplete_ms`). */
export const HOLD_INCOMPLETE_MS = 1200;

const HESITATIONS = new Set(["euh", "heu", "hum", "hmm", "uh", "um", "uhm", "er", "eh"]);
const LINKERS = new Set([
  // fr
  "et", "ou", "mais", "donc", "alors", "puis", "car", "ni", "à", "au", "aux", "de", "du", "des", "le", "la", "les", "un", "une",
  "pour", "avec", "sur", "dans", "que", "qui", "comme", "par", "en", "sans", "chez", "vers",
  // en
  "and", "or", "but", "so", "to", "of", "the", "a", "an", "for", "with", "then", "at", "by", "from",
]);

/**
 * La phrase a-t-elle l'air inachevée (l'utilisateur hésite, il va reprendre) ? Bilingue et prudente :
 * - un seul mot (« oui », « stop », « ok ») : jamais ;
 * - fin sur « … », « ... » ou « , » : oui ;
 * - fin sur une hésitation (euh, uh…) : oui ;
 * - fin sur un mot de liaison (et, de, the…) sans ponctuation finale (« . », « ? », « ! ») : oui ;
 * - fin sur une élision (« l' », « qu' ») : oui.
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length < 2) return false;
  if (/(…|\.\.\.|,)["'»)\]\s]*$/u.test(t)) return true;
  const rawLast = words[words.length - 1]!;
  if (/[a-zà-ÿ]['’]$/iu.test(rawLast)) return true;
  const last = rawLast.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  if (HESITATIONS.has(last)) return true;
  const sentenceEnd = /[.!?]["'»)\]]*$/u.test(t);
  return !sentenceEnd && LINKERS.has(last);
}

export interface ListenOptions {
  vad: VadStream;
  /** Silence attendu par le détecteur avant la fin (rendu dans `transcript.silence_ms`). */
  minSilenceMs: number;
  /** Transcription partagée : les demandes sont traitées une à la fois, dans l'ordre. */
  transcribe(audio: Float32Array): Promise<string>;
  /**
   * Attente (ms) d'une phrase qui a l'air inachevée avant de l'émettre ; 0 = désactivée.
   * Une fonction est relue à chaque phrase (réglage modifiable à chaud). Défaut : HOLD_INCOMPLETE_MS.
   */
  holdIncompleteMs?: number | (() => number);
  /** Horloge en ms (tests). */
  now?: () => number;
  /** Minuteur (tests) : rend la fonction qui l'annule. Défaut : setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?(msg: string): void;
  onClose?(): void;
}

const concat = (parts: Float32Array[]): Float32Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export class ListenStream implements VoiceStream {
  private readonly listeners = new Set<(ev: VoiceEvent) => void>();
  private readonly opts: ListenOptions;
  private readonly now: () => number;
  private closed = false;
  /** Les résultats (transcriptions, dictée) sortent dans l'ordre des demandes. */
  private results: Promise<void> = Promise.resolve();

  private speaking = false;
  private ptting = false;
  private dictating = false;
  private inSpeech = false;
  private barged = false;
  private frames = 0;
  private lastAudio: Float32Array | undefined;
  private lastEnd = -Infinity;
  private turnSpoke = false;
  private received = 0;
  private processed = 0;
  private startSample = 0;
  private lastStart = 0;
  private utt = 0;
  private mergeEnabled = true;
  private merged = false;
  private seg = 0;
  private segFrames = 0;
  private partialAt = 0;
  private partialBusy = false;
  private buf: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private pending = new Float32Array(0);
  /** Transcript retenu en attendant une reprise de parole (phrase qui a l'air inachevée). */
  private held: { ev: Extract<VoiceEvent, { type: "transcript" }>; at: number; cancel: () => void } | undefined;

  constructor(opts: ListenOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
  }

  on(fn: (ev: VoiceEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private emit(ev: VoiceEvent): void { if (!this.closed) for (const fn of [...this.listeners]) fn(ev); }

  /** Lance une transcription ; `send` reçoit le texte (vide en cas d'erreur), dans l'ordre des demandes. */
  private queue(audio: Float32Array | undefined, send: (text: string, sttMs: number) => void, done?: () => void): void {
    const t0 = this.now();
    const job = audio && audio.length ? this.opts.transcribe(audio) : Promise.resolve("");
    const result = job.then((text) => ({ text, ms: this.now() - t0 }), (e: unknown) => {
      this.opts.log?.(`transcription : ${e instanceof Error ? e.message : String(e)}`);
      return { text: "", ms: this.now() - t0 };
    });
    this.results = this.results.then(async () => {
      const r = await result;
      done?.();
      send(r.text, Math.round(r.ms));
    });
  }

  /** Fin d'une phrase. silenceMs : silence attendu par le détecteur avant la fin (0 avec le bouton). */
  private endUtterance(audio: Float32Array, merged: boolean, silenceMs: number, holdable = false): void {
    this.lastAudio = audio;
    this.lastEnd = this.now();
    const start = this.startSample;
    this.lastStart = start;
    this.utt++;
    this.turnSpoke = false;
    if (audio.length <= SR * MIN_UTTERANCE_S) return;
    const utt = this.utt, end = this.processed;
    this.queue(audio, (text, sttMs) => {
      const ev: Extract<VoiceEvent, { type: "transcript" }> = {
        type: "transcript", text, audio_s: Math.round((audio.length / SR) * 100) / 100, stt_ms: sttMs, merged,
        utt, start_sample: start, end_sample: end, silence_ms: silenceMs,
      };
      if (holdable && this.shouldHold(text, utt)) this.hold(ev);
      else this.emit(ev);
    });
  }

  private holdMs(): number {
    const v = this.opts.holdIncompleteMs;
    const ms = typeof v === "function" ? v() : v ?? HOLD_INCOMPLETE_MS;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /** Retenir ? Seulement si la phrase a l'air inachevée, hors coupure de parole, et si la reprise pourrait être recollée. */
  private shouldHold(text: string, utt: number): boolean {
    return !this.closed && !this.speaking && !this.dictating && this.mergeEnabled && utt === this.utt && !this.inSpeech
      && this.holdMs() > 0 && looksUnfinished(text);
  }

  private hold(ev: Extract<VoiceEvent, { type: "transcript" }>): void {
    this.flushHeld();
    const at = this.now();
    const schedule = this.opts.schedule ?? ((fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); });
    const cancel = schedule(() => this.flushHeld(), this.holdMs());
    this.held = { ev, at, cancel };
  }

  /** Émet le transcript retenu avec ses valeurs d'origine ; `silence_ms` compte l'attente (latence mesurée juste). */
  private flushHeld(): void {
    const h = this.held;
    if (!h) return;
    this.held = undefined;
    h.cancel();
    this.emit({ ...h.ev, silence_ms: (h.ev.silence_ms ?? 0) + Math.max(0, Math.round(this.now() - h.at)) });
  }

  /** La parole reprend et sera recollée : le texte retenu n'est jamais émis. */
  private dropHeld(): void {
    this.held?.cancel();
    this.held = undefined;
  }

  /** Fin d'un segment de dictée (pause, arrêt ou segment trop long) : version finale. */
  private dictateEndSegment(): void {
    const audio = concat(this.buf);
    const seg = this.seg++;
    this.segFrames = 0;
    this.queue(audio.length > SR * MIN_UTTERANCE_S ? audio : undefined, (text) => this.emit({ type: "dictation", seg, text, final: true }));
  }

  private resetListening(): void {
    this.opts.vad.reset();
    this.inSpeech = false;
    this.preroll = [];
  }

  pushAudio(frame: Float32Array): void {
    if (this.closed) return;
    this.received += frame.length;
    if (this.ptting) {
      this.buf.push(frame.slice());
      this.processed = this.received;
      return;
    }
    const all = new Float32Array(this.pending.length + frame.length);
    all.set(this.pending);
    all.set(frame, this.pending.length);
    let o = 0;
    for (; o + FRAME <= all.length; o += FRAME) this.onFrame(all.slice(o, o + FRAME));
    this.pending = all.slice(o);
  }

  private onFrame(f: Float32Array): void {
    this.processed += FRAME;
    const events = this.opts.vad.push(f);
    const ev = events[events.length - 1]?.type;
    if (this.dictating) {
      // Dictée : ni interruption ni recollage. Chaque segment est retranscrit en entier régulièrement.
      if (this.inSpeech) { this.buf.push(f); this.segFrames++; }
      else this.preroll = [...this.preroll, f].slice(-PREROLL);
      if (ev === "start" && !this.inSpeech) {
        this.inSpeech = true; this.segFrames = 0; this.partialAt = 0;
        this.buf = [...this.preroll]; this.preroll = [];
      } else if (this.inSpeech && (ev === "end" || this.segFrames * FRAME >= SR * DICTATE_MAX_S)) {
        this.inSpeech = false;
        this.dictateEndSegment();
        this.buf = [];
      } else if (this.inSpeech && (this.segFrames - this.partialAt) * FRAME >= SR * DICTATE_PARTIAL_S && !this.partialBusy) {
        this.partialBusy = true; this.partialAt = this.segFrames;
        const seg = this.seg;
        this.queue(concat(this.buf), (text) => this.emit({ type: "dictation", seg, text, final: false }), () => { this.partialBusy = false; });
      }
      return;
    }
    if (this.inSpeech) {
      this.buf.push(f);
      this.frames++;
      if (this.speaking && !this.barged && this.frames * FRAME_MS >= BARGE_IN_MS) {
        this.barged = true;
        this.emit({ type: "barge_in" });
      }
    } else this.preroll = [...this.preroll, f].slice(-PREROLL);
    if (ev === "start" && !this.inSpeech) {
      this.inSpeech = true; this.frames = 0;
      this.buf = [...this.preroll];
      this.startSample = this.processed - this.preroll.reduce((n, p) => n + p.length, 0);
      this.merged = false;
      const recent = this.held !== undefined || this.now() - this.lastEnd < MERGE_GAP_MS;
      const willMerge = this.mergeEnabled && recent && this.lastAudio && !this.turnSpoke && !this.speaking;
      if (willMerge) this.dropHeld(); else this.flushHeld();
      if (willMerge && this.lastAudio) {
        // Reprise juste après la fin, avant toute réponse parlée : c'est la même phrase.
        this.buf = [this.lastAudio, ...this.buf];
        this.startSample = this.lastStart;
        this.merged = true;
        this.emit({ type: "merge" });
      }
      this.emit({ type: "vad", state: "speech" });
    } else if (ev === "end" && this.inSpeech) {
      this.inSpeech = false;
      this.emit({ type: "vad", state: "silence" });
      const audio = concat(this.buf);
      this.buf = []; this.preroll = [];
      this.endUtterance(audio, this.merged, this.opts.minSilenceMs, true);
    }
  }

  cancel(): void { /* rien à couper : la voix passe par le service tts */ }

  setSpeaking(on: boolean): void {
    this.speaking = on;
    if (on) this.flushHeld();
    if (on) this.turnSpoke = true;
    this.barged = false;
  }

  setMergeEnabled(on: boolean): void {
    this.mergeEnabled = on;
    if (!on) this.flushHeld();
    this.lastAudio = undefined;
  }

  ptt(on: boolean): void {
    if (on && !this.ptting) {
      this.flushHeld();
      this.ptting = true; this.buf = [];
      this.resetListening();
      this.startSample = this.received;
      this.processed = this.received;
      this.pending = new Float32Array(0);
      this.emit({ type: "vad", state: "speech" });
      if (this.speaking) this.emit({ type: "barge_in" });
    } else if (!on && this.ptting) {
      this.ptting = false;
      this.emit({ type: "vad", state: "silence" });
      if (this.buf.length) this.endUtterance(concat(this.buf), false, 0);
      this.buf = [];
      this.resetListening();
    }
  }

  dictate(on: boolean): void {
    if (on && !this.dictating) {
      this.flushHeld();
      this.dictating = true; this.ptting = false; this.buf = [];
      this.resetListening();
      this.segFrames = 0;
      this.pending = new Float32Array(0);
      this.processed = this.received;
    } else if (!on && this.dictating) {
      this.dictating = false;
      if (this.inSpeech) this.dictateEndSegment();
      this.buf = [];
      this.resetListening();
    }
  }

  close(): void {
    if (this.closed) return;
    this.dropHeld();
    this.emit({ type: "closed" });
    this.closed = true;
    this.opts.vad.close();
    this.listeners.clear();
    this.opts.onClose?.();
  }
}
