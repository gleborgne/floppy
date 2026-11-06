// Textes en plusieurs langues pour la fenêtre des réglages (français et anglais de base).
// Un plugin peut donner un texte simple (« Voix ») ou un texte par langue ({ fr: "Voix", en: "Voice" }).
// La fenêtre choisit la langue de l'interface ; le cerveau et la voix utilisent la langue de l'assistant.
export type Text = string | { fr: string; en?: string; [lang: string]: string | undefined };

export const LANGS = [
  { value: "fr", label: "Français", aliases: ["francais", "french"] },
  { value: "en", label: "English", aliases: ["anglais", "english"] },
] as const;

/** Le texte dans la langue demandée (sinon français, sinon la première langue donnée). */
export function tr(t: Text | undefined, lang = "fr"): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return t[lang] ?? t.fr ?? Object.values(t).find((v) => typeof v === "string") ?? "";
}

/** Toutes les formes d'un texte (pour reconnaître un nom dit à l'oral dans n'importe quelle langue). */
export function allTexts(t: Text | undefined): string[] {
  if (t === undefined) return [];
  if (typeof t === "string") return [t];
  return Object.values(t).filter((v): v is string => typeof v === "string");
}

/** Texte en français et en anglais. Raccourci des plugins : `T("Fichier introuvable", "File not found")`. */
export function T(fr: string, en: string): { fr: string; en: string } {
  return { fr, en };
}

/** Langues prises en charge par l'interface et par l'assistant. */
export type Lang = (typeof LANGS)[number]["value"];
export function isLang(v: unknown): v is Lang {
  return LANGS.some((l) => l.value === v);
}

/**
 * Erreur dont le message existe en plusieurs langues. `message` reste en français (journaux) ;
 * le noyau montre `text` dans la langue de celui qui lit (fenêtre, CLI) ou qui écoute (voix).
 */
export class TextError extends Error {
  readonly text: Text;
  constructor(text: Text) {
    super(tr(text, "fr"));
    this.name = "TextError";
    this.text = text;
  }
}

/** Le texte d'une erreur : bilingue si c'est une TextError, sinon son message. */
export function errorText(e: unknown): Text {
  if (e instanceof TextError) return e.text;
  return e instanceof Error ? e.message : String(e);
}
