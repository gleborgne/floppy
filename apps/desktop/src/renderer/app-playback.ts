// Voix (lecture) : file audio, pause (duck), niveau et forme de la bouche, expressions et gestes rejoués à l'heure du son.
// Ils suivent l'horloge audio locale (speech-expressions.ts), jamais le temps de génération ; mouth-shape.ts calcule la bouche.
import type { SpeechGesture } from "@floppy/protocol";
import { SpeechExpressions, type SpeechExpression } from "./speech-expressions.ts";
import { MouthShape } from "./mouth-shape.ts";
import type { Face } from "./app-face.ts";
import type { Life } from "./app-life.ts";
import type { Link } from "./app-session.ts";

export interface PlaybackDeps {
  face: Pick<Face, "setSpeechGesture" | "setSpeechTime" | "setLevel" | "setMouth">;
  /** Une expression audible devient l'émotion du noyau ; la coupure de la parole la remet au neutre. */
  life: Pick<Life, "kernelEmotion" | "resetKernelEmotion">;
  link: Pick<Link, "send">;
}

/** Propriétaire du contexte audio de lecture, de la file de sons, de la pause et de la bouche. */
export function createPlayback(deps: PlaybackDeps) {
  const { face, life, link } = deps;
  const expressions = new SpeechExpressions();
  const speechGestures = new SpeechExpressions<{ intent: SpeechGesture; intensity: number }>();
  let speechPaused = false;
  const play: { ctx: AudioContext | null; head: number; sources: Set<AudioBufferSourceNode>; analyser: AnalyserNode | null; gain: GainNode | null; playing: boolean } = { ctx: null, head: 0, sources: new Set(), analyser: null, gain: null, playing: false };
  /** Contexte audio de lecture, créé au premier morceau de voix. */
  function ensurePlay(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (play.ctx && play.analyser) return { ctx: play.ctx, analyser: play.analyser };
    const ctx = new AudioContext();
    play.ctx = ctx;
    ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    play.analyser = analyser;
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4; // spectre peu moyenné : la forme de la bouche ne traîne pas (le niveau, lui, vient du temporel)
    // Volume après l'analyseur : la bouche bouge pareil quand la voix est baissée.
    const gain = ctx.createGain();
    play.gain = gain;
    analyser.connect(gain);
    gain.connect(ctx.destination);
    return { ctx, analyser };
  }
  function playChunk(buf: ArrayBuffer): void {
    const { ctx, analyser } = ensurePlay();
    const u8 = new Uint8Array(buf);
    const rate = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
    const n = (u8.byteLength - 4) >> 1;
    if (n <= 0) return;
    const pcm = new Int16Array(u8.slice(4).buffer, 0, n);
    const ab = ctx.createBuffer(1, n, rate);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (pcm[i] ?? 0) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(analyser);
    play.head = Math.max(play.head, ctx.currentTime + 0.04);
    src.start(play.head);
    expressions.audio(play.head);
    speechGestures.audio(play.head);
    play.head += ab.duration;
    play.sources.add(src);
    src.onended = () => play.sources.delete(src);
    if (!play.playing) { play.playing = true; link.send({ type: "playback", playing: true }); }
  }
  function stopPlayback() {
    expressions.clear();
    speechGestures.clear();
    face.setSpeechGesture(null);
    life.resetKernelEmotion();
    face.setLevel(0);
    mouthRest();
    for (const s of play.sources) { try { s.stop(); } catch { /* déjà fini */ } }
    play.sources.clear();
    if (play.ctx) play.head = play.ctx.currentTime;
    setDuck(false);
  }
  /** Pause réversible : silence immédiat, sans perdre les mots si le micro a capté un écho. */
  function setDuck(on: boolean): void {
    if (!play.gain || !play.ctx) return;
    if (speechPaused === on) return;
    speechPaused = on;
    play.gain.gain.setTargetAtTime(on ? 0 : 1, play.ctx.currentTime, 0.01);
    if (on) {
      face.setLevel(0);
      mouthRest();
      void play.ctx.suspend().catch(() => {});
    } else void play.ctx.resume().catch(() => {});
  }
  // Niveau de la voix → bouche ; fin de la file → playback:false.
  const levelBuf = new Float32Array(512);
  const freqBuf = new Float32Array(256);
  const mouth = new MouthShape();
  let lastMouthTick = 0;
  /** Bouche au repos : forme et ouverture remises à zéro (pause, coupure, fin de lecture). */
  function mouthRest(): void { mouth.reset(); face.setMouth(0, 0); }
  setInterval(() => {
    if (!play.ctx || !play.analyser) return;
    if (speechPaused) { face.setLevel(0); mouthRest(); return; }
    expressions.tick(play.ctx.currentTime, (e) => life.kernelEmotion(e.emotion, e.intensity, e.ms));
    face.setSpeechTime(play.ctx.currentTime);
    speechGestures.tick(play.ctx.currentTime, (gesture, at) => face.setSpeechGesture(gesture.intent, gesture.intensity, at));
    play.analyser.getFloatTimeDomainData(levelBuf);
    let s = 0;
    for (const v of levelBuf) s += v * v;
    const level = Math.min(1, Math.sqrt(s / levelBuf.length) * 5);
    face.setLevel(level);
    // Forme de la bouche d'après le spectre (en plus du niveau, que les avatars sans setMouth continuent d'utiliser).
    const nowMs = performance.now();
    play.analyser.getFloatFrequencyData(freqBuf);
    const shape = mouth.update(freqBuf, play.ctx.sampleRate, level, lastMouthTick ? Math.min(100, nowMs - lastMouthTick) : 33);
    lastMouthTick = nowMs;
    face.setMouth(shape.open, shape.wide);
    if (play.playing && play.ctx.currentTime > play.head + 0.05) {
      play.playing = false;
      face.setLevel(0);
      mouthRest();
      face.setSpeechGesture(null);
      link.send({ type: "playback", playing: false });
    }
  }, 33);
  return {
    /** Morceau de voix : 4 octets de taux d'échantillonnage + PCM int16. */
    playChunk,
    /** Coupure : silence, bouche et expressions remises à zéro, file vidée. */
    stop: stopPlayback,
    duck: setDuck,
    /** Émotion à montrer quand le prochain morceau audio sera audible. */
    markEmotion(expression: SpeechExpression): void { expressions.mark(expression); },
    /** Geste à montrer quand le prochain morceau audio sera audible. */
    markGesture(gesture: { intent: SpeechGesture; intensity: number }): void { speechGestures.mark(gesture); },
  };
}
export type Playback = ReturnType<typeof createPlayback>;
