// Micro : capture 16 kHz, niveau (oreille de l'avatar, pilule de dictée, indicateur d'écoute) et envoi au noyau.
import { $, errText } from "./app-dom.ts";
import type { Bubble } from "./app-bubble.ts";
import type { Face } from "./app-face.ts";
import type { Link, SessionView } from "./app-session.ts";

const WORKLET = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === 512) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("mic", Mic);`;

export interface MicDeps {
  face: Pick<Face, "setHearing">;
  /** Lecture seule : l'avatar n'entend que pendant l'écoute ; le muet coupe l'envoi, sauf pour la dictée. */
  session: Pick<SessionView, "state" | "muted" | "dictating">;
  link: Pick<Link, "port">;
  bubble: Pick<Bubble, "listening" | "card">;
  host?: FloppyHostApi;
}

/** Propriétaire du micro : démarré une fois, au premier message welcome. */
export function createMic(deps: MicDeps) {
  const { face, session, link, bubble, host } = deps;
  let micStarted = false;
  let lastLevelAt = 0;
  async function start() {
    if (micStarted) return;
    micStarted = true;
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      const node = new AudioWorkletNode(ctx, "mic");
      let frames = 0, peak = 0, lastLog = performance.now();
      node.port.onmessage = (e) => {
        frames++;
        let sq = 0;
        for (const v of e.data) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
        // Ce qu'il entend : l'avatar réagit à la voix (seulement quand il écoute vraiment).
        const heard = session.muted || session.state !== "listening" ? 0 : Math.min(1, Math.sqrt(sq / e.data.length) * 9);
        face.setHearing(heard);
        // Dictée : le niveau du micro anime la pilule (environ 20 fois par seconde).
        if (session.dictating && performance.now() - lastLevelAt > 50) { lastLevelAt = performance.now(); host?.dictationLevel?.(Math.min(1, Math.sqrt(sq / e.data.length) * 9)); }
        if (bubble.listening()) $("listen").style.setProperty("--lvl", heard.toFixed(2));
        if (performance.now() - lastLog > 10000) {
          console.log(`micro : ${frames} trames en 10 s, crête ${peak.toFixed(3)}, contexte ${ctx.state}, port ${link.port ? "ok" : "absent"}`);
          frames = 0; peak = 0; lastLog = performance.now();
        }
        // Copie (pas de transfert de tampon : Electron abandonne ces messages vers le utilityProcess).
        if (link.port && (!session.muted || session.dictating)) link.port.postMessage({ a: e.data }); // la dictée écoute même quand Floppy dort
      };
      ctx.createMediaStreamSource(stream).connect(node);
      const track = stream.getAudioTracks()[0];
      console.log(`micro actif : « ${track?.label ?? "?"} », ${ctx.sampleRate} Hz, contexte ${ctx.state}`);
    } catch (e) {
      micStarted = false;
      console.log(`micro indisponible : ${errText(e)}`);
      bubble.card("error", { key: "micDown" }, errText(e));
    }
  }
  return { start };
}
export type Mic = ReturnType<typeof createMic>;
