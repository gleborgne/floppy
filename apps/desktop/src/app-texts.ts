// Langue de l'interface et textes du processus principal : le propriétaire de `lang` et des raccourcis choisis.
import { TEXTS, keysForOS } from "./main-texts.ts";
import type { Lang, TextKey } from "./main-texts.ts";
import type { Bilingual } from "./placement.ts";

// Raccourcis par défaut (les mêmes que plugins/body/electron/src/shortcuts.ts) ; le noyau envoie ceux choisis (display.raccourcis).
export const SHORTCUT_DEFAULTS: Record<string, string> = { parler: "Ctrl+Alt+F", ecrire: "Ctrl+Alt+T", dicter: "Ctrl+Alt+D", dormir: "Ctrl+Alt+M", avatar: "Ctrl+Alt+H" };

export interface Texts {
  /** Langue de l'interface (réglage « langue_interface » du noyau). */
  lang(): Lang;
  /** Change la langue ; faux si elle n'est pas reconnue ou ne change pas (rien à propager). */
  setLangValue(l: unknown): boolean;
  /** Raccourcis posés (action → touches) : le module des raccourcis les met à jour. */
  shortcuts: Record<string, string>;
  T(k: TextKey): string;
  both(k: TextKey): Bilingual;
  trx(x: unknown): string;
  problemName(id: string): string;
  textError(text: Bilingual): Error & { text: Bilingual };
  waitText(missing?: string[]): string;
}

export function createTexts(): Texts {
  let lang: Lang = "fr";                // langue de l'interface (réglage « langue_interface » du noyau)
  const shortcuts: Record<string, string> = { ...SHORTCUT_DEFAULTS };
  /** Remplace « (Ctrl+Alt+F) » des textes par le raccourci choisi pour cette action ; rien s'il est désactivé. */
  const withKeys = (s: string): string => Object.entries(SHORTCUT_DEFAULTS)
    .reduce((acc, [a, def]) => acc.replaceAll(` (${def})`, shortcuts[a] ? ` (${shortcuts[a]})` : ""), s);
  const T = (k: TextKey): string => keysForOS(withKeys((TEXTS[lang] ?? TEXTS.fr)[k] ?? TEXTS.fr[k] ?? k));
  /** Le même texte dans les deux langues (pour ce qui repart vers le noyau : il choisit la langue de celui qui lit ou écoute). */
  const both = (k: TextKey): Bilingual => ({ fr: TEXTS.fr[k], en: TEXTS.en[k] });
  /** Texte simple, ou { fr, en } (venu du noyau), dans la langue de l'interface. */
  const trx = (x: unknown): string => (x && typeof x === "object" ? ((x as Record<string, unknown>)[lang] ?? (x as Record<string, unknown>).fr ?? Object.values(x).find((v) => typeof v === "string") ?? "") : String(x ?? "")) as string;
  /** Nom d'un problème montré dans l'icône (id d'un plugin, ou « dictée », « raccourci »). */
  const problemName = (id: string): string => ((TEXTS[lang] ?? TEXTS.fr).problemNames as Record<string, string>)[id.startsWith("raccourci_") ? "raccourci" : id] ?? id;
  /** Erreur dont le message existe en fr et en en (`text`). */
  const textError = (text: Bilingual): Error & { text: Bilingual } => Object.assign(new Error(text.fr), { text });
  const waitText = (missing?: string[]) => `${T("waits")} ${(missing ?? []).join(", ")}`;
  function setLangValue(l: unknown): boolean {
    if ((l !== "fr" && l !== "en") || l === lang) return false;
    lang = l;
    return true;
  }
  return { lang: () => lang, setLangValue, shortcuts, T, both, trx, problemName, textError, waitText };
}
