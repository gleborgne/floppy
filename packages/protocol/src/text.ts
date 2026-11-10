// Normalisation de texte : accents, casse, ponctuation. Sans dépendance, pour que le noyau, les plugins et les corps s'en servent.
// Quelques briques qui se composent ; chaque variante qui existait ailleurs s'écrit avec elles (voir packages/protocol/test/text.test.ts).
// Seuls les accents latins usuels sont visés : on décompose (NFD) puis on retire les marques combinantes U+0300–U+036F.
// « œ », « ß » ou « æ » ne sont pas décomposés : ils restent tels quels (et passent donc sous le filtre [^a-z]).

/** Retire les accents (marques combinantes après décomposition NFD). La casse et le reste sont conservés. */
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Clé de comparaison : minuscules puis sans accents. Ni apostrophes, ni espaces, ni ponctuation touchés.
 * Mettre en minuscules avant ou après la suppression des accents donne le même texte (vérifié sur tous les points de code).
 */
export function fold(s: string): string {
  return stripAccents(s.toLowerCase());
}

/** Mots de la clé de comparaison : suites de a-z et 0-9 (tout le reste sépare), dans l'ordre. */
export function foldTokens(s: string): string[] {
  return fold(s).match(/[a-z0-9]+/g) ?? [];
}

/** Clé de mots : clé de comparaison où chaque suite hors a-z0-9 devient une espace, sans espace aux bords. */
export function wordsKey(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, " ").trim();
}

/** Identifiant lisible : clé de comparaison où chaque suite hors a-z0-9 devient `sep`, sans `sep` aux bords (« Été 2024 ! » → « ete-2024 »). */
export function slugify(s: string, sep: "-" | "_" = "-"): string {
  return fold(s).replace(/[^a-z0-9]+/g, sep).replace(sep === "-" ? /^-+|-+$/g : /^_+|_+$/g, "");
}
