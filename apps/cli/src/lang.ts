// Langue des messages propres à la CLI : la langue de l'interface (réglage `langue_interface`),
// lue dans <home>/settings.json. Les réponses du noyau arrivent déjà traduites.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLang, tr, type Lang, type Text } from "@floppy/core";

/** Langue de l'interface gardée dans <home>/settings.json (sinon le français). */
export function cliLang(home: string): Lang {
  try {
    const v = (JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>).langue_interface;
    return isLang(v) ? v : "fr";
  } catch {
    return "fr";
  }
}

/** Raccourci : `say("Relancé.", "Restarted.")` dans la langue de l'interface. */
export function sayer(lang: string): (fr: string, en: string) => string {
  return (fr, en) => (lang === "en" ? en : fr);
}

/** Un texte venu du noyau (simple ou { fr, en }) dans la langue de l'interface. */
export function show(t: Text | undefined, lang: string): string {
  return tr(t, lang);
}
