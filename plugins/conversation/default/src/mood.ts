// Humeur de Floppy : un fond émotionnel qui change lentement (valence, énergie ; voir Mood dans le protocole).
// - Chaque émotion montrée la pousse un peu (une bonne nouvelle rend joyeux, des échecs rendent penaud).
// - Elle revient doucement vers le caractère de base (plutôt content, assez en forme).
// - Seul longtemps, Floppy perd de l'énergie : il s'ennuie, puis il a sommeil.
import { EMOTIONS, type Emotion, type Mood } from "@floppy/protocol";
import { EMOTION_SHEET, emotionInfo } from "@floppy/toolkit";

/** Effet d'une émotion sur l'humeur : [valence visée, énergie visée]. Lu dans la fiche des émotions (`@floppy/contracts`). */
export const AFFECT = Object.fromEntries(EMOTIONS.map((e) => [e, EMOTION_SHEET[e].affect])) as Record<Emotion, [number, number]>;

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
    const info = emotionInfo(emotion);
    if (info && !info.moves) return; // émotion de situation : l'humeur ne bouge pas
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
