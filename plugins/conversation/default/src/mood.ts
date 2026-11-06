// Humeur de Floppy : un fond émotionnel qui change lentement (valence, énergie ; voir Mood dans le protocole).
// - Chaque émotion montrée la pousse un peu (une bonne nouvelle rend joyeux, des échecs rendent penaud).
// - Elle revient doucement vers le caractère de base (plutôt content, assez en forme).
// - Seul longtemps, Floppy perd de l'énergie : il s'ennuie, puis il a sommeil.
import type { Emotion, Mood } from "@floppy/protocol";

/** Effet d'une émotion sur l'humeur : [valence visée, énergie visée]. */
export const AFFECT: Record<Emotion, [number, number]> = {
  neutral: [0, 0.5],
  happy: [0.6, 0.6], joy: [0.85, 0.8], laugh: [0.9, 0.9], love: [0.9, 0.6], excited: [0.75, 1], proud: [0.7, 0.75],
  relieved: [0.45, 0.4], determined: [0.3, 0.85], mischief: [0.5, 0.75], wink: [0.5, 0.65], curious: [0.25, 0.7],
  surprised: [0.1, 0.85], shocked: [-0.2, 0.95], thinking: [0, 0.55], focused: [0.05, 0.65], shy: [0.3, 0.4],
  confused: [-0.25, 0.5], skeptical: [-0.2, 0.5], sorry: [-0.45, 0.35], sad: [-0.7, 0.25], cry: [-0.85, 0.35],
  annoyed: [-0.45, 0.6], angry: [-0.7, 0.85], scared: [-0.55, 0.9], bored: [-0.15, 0.15], tired: [-0.1, 0.12], sleepy: [0, 0.05],
};
/** Émotions de situation (la conversation les met elle-même) : elles ne changent pas l'humeur. */
const NO_EFFECT = new Set<Emotion>(["neutral", "thinking", "focused", "sleepy"]);

export interface MoodOptions {
  /** Caractère de base, vers lequel l'humeur revient. */
  base?: Mood;
  now?: () => number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 100) / 100;

export class MoodTracker {
  valence: number;
  energy: number;
  private readonly base: Mood;
  private readonly now: () => number;
  private lastTick: number;
  private lastActive: number;
  private sent: Mood | undefined;

  constructor(opts: MoodOptions = {}) {
    this.base = opts.base ?? { valence: 0.2, energy: 0.6 };
    this.now = opts.now ?? Date.now;
    this.valence = this.base.valence;
    this.energy = this.base.energy;
    this.lastTick = this.lastActive = this.now();
  }

  /** Une émotion vient d'être montrée. intensity : 1 normale. */
  feel(emotion: Emotion, intensity = 1): void {
    this.tick();
    if (NO_EFFECT.has(emotion)) return;
    const [v, e] = AFFECT[emotion] ?? [0, 0.5];
    const w = clamp(0.22 * intensity, 0.05, 0.4);
    this.valence = clamp(this.valence + (v - this.valence) * w, -1, 1);
    this.energy = clamp(this.energy + (e - this.energy) * w * 0.7, 0, 1);
  }

  /** On lui parle : il se réveille un peu (l'énergie remonte vers la base). */
  touch(): void {
    this.tick();
    this.lastActive = this.now();
    if (this.energy < this.base.energy) this.energy += (this.base.energy - this.energy) * 0.5;
  }

  /** Fait passer le temps : retour vers la base (demi-vie ~8 min) ; seul plus de 3 min, l'énergie baisse. */
  tick(): void {
    const now = this.now();
    const dt = Math.max(0, now - this.lastTick) / 1000;
    this.lastTick = now;
    if (!dt) return;
    const k = 1 - Math.pow(0.5, dt / 480);
    this.valence += (this.base.valence - this.valence) * k;
    const alone = (now - this.lastActive) / 1000 > 180;
    const goal = alone ? 0.08 : this.base.energy;
    // Seul : l'énergie descend en ~20 min. Accompagné : retour vers la base.
    const ke = 1 - Math.pow(0.5, dt / (alone ? 420 : 300));
    this.energy += (goal - this.energy) * ke;
  }

  snapshot(): Mood {
    return { valence: round(this.valence), energy: round(this.energy) };
  }

  /** Humeur à envoyer aux corps, seulement si elle a changé nettement depuis le dernier envoi. */
  changed(min = 0.04): Mood | undefined {
    const m = this.snapshot();
    if (this.sent && Math.abs(m.valence - this.sent.valence) < min && Math.abs(m.energy - this.sent.energy) < min) return undefined;
    this.sent = m;
    return m;
  }
}
