// Fenêtre « Bienvenue » : l'extrait sonore d'une voix, lu dans la fenêtre (un seul son à la fois).
// L'adresse vient de la bibliothèque de modèles (http ou https) ; la CSP de la page n'autorise que ça pour les médias.

let audio: HTMLAudioElement | null = null;
let playing: string | null = null;
let changed: () => void = () => {};

/** L'extrait en cours de lecture (la valeur du choix), ou null. */
export const playingSample = (): string | null => playing;

/** `onChange` est appelé quand la lecture démarre ou s'arrête (la page se redessine). */
export function onSampleChange(fn: () => void): void { changed = fn; }

/** Arrête le son en cours. */
export function stopSample(): void {
  if (!audio && playing === null) return;
  audio?.pause();
  audio = null;
  playing = null;
  changed();
}

/** Lit l'extrait d'un choix ; le même choix une seconde fois l'arrête. Adresse qui n'est pas http(s) : rien. */
export function toggleSample(value: string, url: string): void {
  if (playing === value) { stopSample(); return; }
  if (!/^https?:\/\//i.test(url)) return;
  audio?.pause();
  const el = new Audio(url);
  audio = el;
  playing = value;
  const end = () => { if (audio === el) { audio = null; playing = null; changed(); } };
  el.addEventListener("ended", end);
  el.addEventListener("error", end);
  el.play().catch(end);
  changed();
}
