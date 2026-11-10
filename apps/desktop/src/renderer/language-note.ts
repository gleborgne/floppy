// Note d'un modèle pour une langue (« Français : bien »), montrée par la fenêtre « Bienvenue » et par les Réglages.
// Règles sans DOM, testées à part. Les notes viennent des bibliothèques de modèles (`ItemInfo.languages`).

export type LanguageLevel = "good" | "fair" | "poor";
/** Ton de l'étiquette : « warn » pour une langue mal gérée (étiquette jaune), « plain » sinon (étiquette grise). */
export interface LanguageNote { text: string; tone: "plain" | "warn"; level: LanguageLevel }

const WORDS: Record<"fr" | "en", Record<LanguageLevel, string>> = {
  fr: { good: "bien", fair: "moyen", poor: "mal" },
  en: { good: "good", fair: "fair", poor: "poor" },
};

/** Nom d'une langue (« fr » → « Français » / « French ») dans la langue de la fenêtre ; code inconnu : le code. */
export function languageName(code: string, ui: string): string {
  try {
    const name = new Intl.DisplayNames([ui === "en" ? "en" : "fr"], { type: "language" }).of(code);
    return name && name !== code ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch { return code; }
}

/** « Français : bien » / « French: good ». Note absente (langue inconnue pour ce modèle) : null, rien à montrer. */
export function languageNote(level: string | undefined | null, language: string, ui: string): LanguageNote | null {
  if (level !== "good" && level !== "fair" && level !== "poor") return null;
  const en = ui === "en";
  const text = `${languageName(language, ui)}${en ? ": " : " : "}${WORDS[en ? "en" : "fr"][level]}`;
  return { text, tone: level === "poor" ? "warn" : "plain", level };
}

/** La note d'un élément (`ItemInfo.languages`) pour la langue de l'utilisateur. */
export function itemLanguageNote(languages: Record<string, string> | undefined | null, language: string, ui: string): LanguageNote | null {
  return languageNote(languages?.[language], language, ui);
}
