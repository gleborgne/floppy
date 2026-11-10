// L'émotion d'une étiquette s'apaise sur les phrases suivantes (mode voix séparé ; le Live ne l'utilise pas).
// La phrase qui porte l'étiquette garde son intensité ; chacune des suivantes, sans nouvelle étiquette, prend
// celle d'avant × SETTLE_FACTOR. Sous SETTLE_FLOOR l'émotion tombe : plus d'émotion jusqu'à la prochaine étiquette.
// Avec une intensité de 1 : 1 → 0.6 → 0.36 → aucune.
export const SETTLE_FACTOR = 0.6;
export const SETTLE_FLOOR = 0.3;

export interface Felt { emotion: string; intensity?: number }

/** Ce que donne une phrase : son émotion (voix, geste) et l'expression à montrer quand elle commence. */
export interface Settled {
  /** Émotion de la phrase ; absente : plus d'émotion (jeu neutre). */
  emotion?: string;
  intensity?: number;
  /** Expression à planifier pour cette phrase ; absente : le visage ne change pas. */
  cue?: Felt;
  /** Vrai si l'expression n'est qu'un apaisement : elle ne doit pas pousser l'humeur. */
  settling: boolean;
}

export class EmotionSettler {
  private current: Felt | undefined;

  /** La phrase suivante de la réponse ; `tag` : l'étiquette arrivée juste avant elle. */
  next(tag?: Felt): Settled {
    if (tag) {
      this.current = tag;
      return { emotion: tag.emotion, ...(tag.intensity === undefined ? {} : { intensity: tag.intensity }), cue: tag, settling: false };
    }
    if (!this.current) return { settling: false };
    const intensity = (this.current.intensity ?? 1) * SETTLE_FACTOR;
    if (intensity < SETTLE_FLOOR) {
      this.current = undefined;
      return { cue: { emotion: "neutral" }, settling: true }; // le visage redescend une seule fois
    }
    this.current = { emotion: this.current.emotion, intensity };
    return { emotion: this.current.emotion, intensity, cue: this.current, settling: true };
  }
}
