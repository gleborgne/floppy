// Petites manies au repos : le choix, pur (ni minuterie, ni DOM). app-life.ts exécute le résultat.
// L'humeur et ce qui vient de se passer orientent le choix : pas de clin d'œil malicieux juste après une erreur.

export interface QuirkContext {
  valence: number;        // -1..1 (base du noyau : environ 0.2)
  energy: number;         // 0..1 (base : environ 0.6)
  aloneMs: number;        // temps écoulé depuis la dernière activité
  kernelEmotion: string;  // dernière émotion envoyée par le noyau
  kernelAgoMs: number;    // et depuis combien de temps
  random: () => number;   // 0..1
}

export type Quirk =
  | { kind: "flash"; name: string; ms: number; intensity: number; cue?: string }
  | { kind: "look"; x: number; y: number }
  | { kind: "cue"; name: string }
  | { kind: "none" };

/** Émotions du noyau qui interdisent les manies joueuses pendant la minute qui suit. */
export const NEGATIVE_EMOTIONS: readonly string[] = ["sorry", "sad", "confused", "annoyed", "angry", "scared", "cry"];
export const NEGATIVE_WINDOW_MS = 60000;
/** En dessous : humeur nettement négative (après des refus ou des erreurs). */
export const LOW_VALENCE = -0.25;
/** Au-dessus : humeur franchement bonne, les manies joueuses sont plus fréquentes. */
export const HIGH_VALENCE = 0.5;

function look(random: () => number): Quirk {
  return { kind: "look", x: random() * 2 - 1, y: random() - 0.6 };
}

export function chooseQuirk(c: QuirkContext): Quirk {
  const lowMood = c.valence < LOW_VALENCE;
  const recentBad = NEGATIVE_EMOTIONS.includes(c.kernelEmotion) && c.kernelAgoMs < NEGATIVE_WINDOW_MS;
  const r = c.random();
  if (c.energy < 0.35 && r < 0.5) return { kind: "flash", name: "tired", ms: 1900, intensity: 1.2 }; // bâillement
  if (c.aloneMs > 180000 && r < 0.35) return { kind: "flash", name: "bored", ms: 2600, intensity: 0.7 };
  if (lowMood || recentBad) {
    // Seulement du calme : un regard ailleurs, un soupir discret, ou rien.
    if (r < 0.4) return look(c.random);
    if (r < 0.65) return { kind: "flash", name: "tired", ms: 1900, intensity: 0.6 };
    if (r < 0.8 && lowMood) return { kind: "flash", name: "sad", ms: 1800, intensity: 0.35 };
    return { kind: "none" };
  }
  // Bonne humeur : moins de regards ailleurs, davantage de clins d'œil et de malice.
  const t = c.valence > HIGH_VALENCE ? [0.2, 0.32, 0.52, 0.68, 0.84] : [0.3, 0.45, 0.6, 0.72, 0.82];
  if (r < t[0]!) return look(c.random);                                                            // un coup d'œil ailleurs
  if (r < t[1]!) return { kind: "flash", name: "curious", ms: 1500, intensity: 0.6 };
  if (r < t[2]!) return { kind: "flash", name: "happy", ms: 2200, intensity: 0.5, cue: "nod" };    // il chantonne dans sa tête
  if (r < t[3]!) return { kind: "flash", name: "mischief", ms: 900, intensity: 0.6 };
  if (r < t[4]!) return { kind: "flash", name: "wink", ms: 650, intensity: 1 };
  return { kind: "cue", name: "perk" };
}
