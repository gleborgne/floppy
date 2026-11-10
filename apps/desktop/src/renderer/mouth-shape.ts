// Forme de la bouche d'après le son : `open` (ouverture) et `wide` (0 = arrondie « o/ou », 1 = étirée « i/é/s »).
// Pur : ni minuterie ni DOM. Ce n'est pas de la reconnaissance de phonèmes, seulement l'équilibre du spectre.
//
// Entrée : getFloatFrequencyData (décibels, -Infinity pour le silence) plutôt que les octets : l'octet écrase
// la plage -100..-30 dB (une voyelle forte sature), le rapport entre bandes y serait faussé. On repasse en puissance.
// `open` reprend le niveau RMS que l'application calcule déjà (domaine temporel) : la bouche ne devient ni plus
// petite ni plus grande en moyenne ; ici on le lisse seulement.

/** Bande basse (fondamentale, premier formant) et bande haute (second formant de « i/é », friction de « s »), en Hz. */
export const LOW_BAND: [number, number] = [100, 1000];
export const HIGH_BAND: [number, number] = [1800, 7000];
/** Part d'énergie haute qui compte pour 0 et pour 1 : une voyelle « i » tourne autour de 0.1-0.25, un « s » bien au-delà. */
export const SHARE_FLOOR = 0.03;
export const SHARE_SPAN = 0.3;
/** Sous ce niveau (même échelle que setLevel), la bouche est au repos : la forme revient à 0. */
export const SILENCE_LEVEL = 0.03;
/** Constantes de temps (ms) : montée vive, descente un peu plus lente, pour ne pas traîner derrière la voix. */
export const ATTACK_MS = 20;
export const RELEASE_MS = 55;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class MouthShape {
  open = 0;
  wide = 0;

  /**
   * @param freqDb  données de l'analyseur en dB (taille fftSize / 2)
   * @param sampleRate  fréquence d'échantillonnage du contexte audio
   * @param level  niveau 0..1 transmis à setLevel (RMS × 5)
   * @param dtMs  temps écoulé depuis l'appel précédent (le lissage ne dépend pas de la cadence)
   */
  update(freqDb: ArrayLike<number>, sampleRate: number, level: number, dtMs: number): { open: number; wide: number } {
    const binHz = sampleRate / 2 / Math.max(1, freqDb.length);
    const band = ([lo, hi]: [number, number]): number => {
      let sum = 0;
      const from = Math.max(0, Math.floor(lo / binHz)), to = Math.min(freqDb.length - 1, Math.ceil(hi / binHz));
      for (let i = from; i <= to; i++) {
        const db = freqDb[i] ?? -Infinity;
        if (Number.isFinite(db)) sum += Math.pow(10, db / 10);
      }
      return sum;
    };
    const low = band(LOW_BAND), high = band(HIGH_BAND);
    const total = low + high;
    const share = total > 0 ? high / total : 0;
    const targetWide = level < SILENCE_LEVEL ? 0 : clamp01((share - SHARE_FLOOR) / SHARE_SPAN);
    const targetOpen = clamp01(level);
    this.open = follow(this.open, targetOpen, dtMs);
    this.wide = follow(this.wide, targetWide, dtMs);
    return { open: this.open, wide: this.wide };
  }

  reset(): void { this.open = 0; this.wide = 0; }
}

/** Lissage exponentiel indépendant de la cadence, avec montée plus vive que la descente. */
function follow(current: number, target: number, dtMs: number): number {
  const tau = target > current ? ATTACK_MS : RELEASE_MS;
  const v = current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
  return v < 0.002 && target === 0 ? 0 : v;
}
