// Écho : le micro reprend la voix de Floppy (haut-parleurs, anti-écho du système imparfait).
// On compare ce que le micro a entendu avec ce que Floppy vient de dire. Mots en commun = écho.

/** Mots en minuscules, sans accents ni ponctuation. */
export function words(text: string): string[] {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/**
 * Vrai si `heard` ressemble à un morceau de ce que Floppy a dit (`spoken`).
 * - 1 mot : jamais un écho (« stop », « attends » doivent toujours couper la parole).
 * - 2 mots : seulement s'ils se suivent tels quels dans ce qui a été dit.
 * - 3 mots et plus : au moins 70 % des mots entendus sont dans ce qui a été dit (le STT déforme un peu l'écho).
 */
export function isEcho(heard: string, spoken: string[]): boolean {
  const h = words(heard);
  if (h.length < 2 || !spoken.length) return false;
  const said = spoken.flatMap(words);
  if (h.length === 2) {
    for (let i = 0; i + 1 < said.length; i++) if (said[i] === h[0] && said[i + 1] === h[1]) return true;
    return false;
  }
  const set = new Set(said);
  return h.filter((w) => set.has(w)).length / h.length >= 0.7;
}
