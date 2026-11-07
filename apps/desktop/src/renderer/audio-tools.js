// Outils purs pour l'enregistrement d'une voix (fenêtre des réglages) : WAV, silence aux bords, qualité, forme d'onde.
// Aucune dépendance au navigateur : testés sous Node (apps/desktop/test/audio-tools.test.ts).

/** Fréquence des enregistrements gardés : celle des modèles de voix (Qwen3, Pocket TTS). */
export const RATE = 24000;

/** Échantillons flottants (-1..1) -> fichier WAV 16 bits mono. */
export function encodeWav(samples, rate = RATE) {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

/** Octets -> adresse data:audio/wav (ce que la fenêtre envoie au noyau). */
export function wavDataUrl(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(s)}`;
}

/** Niveau (RMS) de chaque tranche de `win` échantillons. */
function frames(samples, win) {
  const out = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  return out;
}

/**
 * Coupe le silence au début et à la fin (on garde 0,2 s de marge) : le bruit du clic ne fait pas partie de la voix.
 * Seuil : un dixième du niveau des passages parlés, au moins 0,01.
 */
export function trimSilence(samples, rate = RATE) {
  const win = Math.round(rate / 50); // 20 ms
  const lv = frames(samples, win);
  if (!lv.length) return samples;
  const sorted = [...lv].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const th = Math.max(0.01, loud / 10);
  const first = lv.findIndex((x) => x > th);
  if (first < 0) return samples.slice(0, 0);
  let last = lv.length - 1;
  while (last > first && lv[last] <= th) last--;
  const pad = Math.round(rate * 0.2);
  return samples.slice(Math.max(0, first * win - pad), Math.min(samples.length, (last + 1) * win + pad));
}

/**
 * Qualité d'un enregistrement : durée, son saturé (crêtes à fond), trop faible, bruit de fond (niveau des passages
 * les plus calmes comparé à celui de la voix). À lancer sur l'enregistrement entier : ses bords donnent le bruit de la pièce.
 */
export function analyze(samples, rate = RATE) {
  let peak = 0, clipped = 0;
  for (const x of samples) { const a = Math.abs(x); if (a > peak) peak = a; if (a >= 0.99) clipped++; }
  const lv = frames(samples, Math.round(rate / 50)).sort((a, b) => a - b);
  const quiet = lv[Math.floor(lv.length * 0.05)] ?? 0;
  const loud = lv[Math.floor(lv.length * 0.9)] ?? 0;
  return {
    seconds: samples.length / rate,
    peak,
    // Quelques crêtes isolées passent ; au-delà d'un millième des échantillons, la voix grésille.
    clipped: clipped > samples.length / 1000,
    tooQuiet: peak < 0.1,
    noisy: loud > 0 && quiet / loud > 0.25,
  };
}

/** Hauteurs (0..1) de `n` barres pour dessiner la forme d'onde. */
export function waveBars(samples, n = 96) {
  const win = Math.max(1, Math.floor(samples.length / n));
  const lv = frames(samples, win).slice(0, n);
  const max = Math.max(1e-6, ...lv);
  return lv.map((x) => x / max);
}

