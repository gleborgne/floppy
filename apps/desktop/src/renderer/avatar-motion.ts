import type { SpeechGesture } from "@floppy/protocol";

/** Signaux sans unité, interprétés par chaque dessin (aucun paramètre propre à une TV ou un chat). */
export interface MotionPose { nod: number; lean: number; lookX: number; lookY: number; smile: number; open: number }
const zero = (): MotionPose => ({ nod: 0, lean: 0, lookX: 0, lookY: 0, smile: 0, open: 0 });
const ease = (x: number) => { const p = Math.max(0, Math.min(1, x)); return p ** 3 * (p * (p * 6 - 15) + 10); };
const pulse = (t: number, delay: number, rise: number, fall: number) => t < delay ? 0 : t < delay + rise
  ? ease((t - delay) / rise) : 1 - ease((t - delay - rise) / fall);
type Gesture = { intent: SpeechGesture; at: number; side: number; strength: number };

/** Une horloge de lecture commune ; les images entre deux ticks audio restent interpolées par le dessin. */
export class AvatarMotion {
  private time = 0;
  private state = "idle";
  private attention = "idle";
  private sequence = 0;
  private active?: Gesture;
  private previous?: { pose: MotionPose; at: number };
  private readonly reducedMotion: boolean;
  constructor(reducedMotion = false) { this.reducedMotion = reducedMotion; }
  setTime(seconds: number): void { if (Number.isFinite(seconds)) this.time = seconds * 1000; }
  setState(state: string): void { this.state = state; this.attention = state; if (state !== "speaking") this.clear(); }
  setAttention(target: string): void { this.attention = target; }
  clear(): void { this.active = undefined; this.previous = undefined; }
  play(intent: SpeechGesture | null, intensity = 1, seconds = this.time / 1000): void {
    if (intent === null || this.reducedMotion) { this.clear(); return; }
    const at = seconds * 1000;
    if (!Number.isFinite(at)) return;
    if (intent !== "none" && this.active?.intent === intent && at - this.active.at < 700) return;
    this.previous = { pose: this.pose(at), at };
    const n = this.sequence++;
    this.active = { intent, at, side: n % 2 ? 1 : -1,
      strength: Math.max(0, Math.min(1.3, Number.isFinite(intensity) ? intensity : 1)) * [1, 0.9, 1.05][n % 3]! };
  }
  private pose(now: number): MotionPose {
    const out = zero(), a = this.active;
    if (a) {
      const t = now - a.at, s = a.strength;
      if (a.intent === "explain") { out.nod = (pulse(t, 100, 230, 340) + 0.65 * pulse(t, 700, 210, 350)) * s; out.lean = out.nod * a.side * 0.35; }
      else if (a.intent === "playful") { out.smile = pulse(t, 140, 320, 740) * s; out.lean = out.smile * a.side * 0.85; out.lookX = out.smile * a.side * 0.77; }
      else if (a.intent === "question") { out.open = pulse(t, 60, 340, 850) * s; out.lean = out.open * a.side; out.lookX = out.open * a.side; out.lookY = -out.open; }
    }
    if (this.previous) {
      const weight = 1 - ease((now - this.previous.at) / 220);
      for (const key of Object.keys(out) as (keyof MotionPose)[]) out[key] += this.previous.pose[key] * weight;
    }
    return out;
  }
  sample(): MotionPose {
    return this.reducedMotion || this.state !== "speaking" || this.attention === "approval" ? zero() : this.pose(this.time);
  }
  gaze(): { x: number; y: number } | null {
    if (this.attention === "approval") return { x: 0, y: -0.8 };
    if (this.attention === "thinking") return { x: 0.5, y: -0.5 };
    if (this.attention === "listening" || this.attention === "speaking") return { x: 0, y: 0 };
    return null;
  }
}
