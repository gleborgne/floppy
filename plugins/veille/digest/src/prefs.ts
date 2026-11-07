// Préférences de la veille : ce que l'utilisateur aime, évite, ne veut plus jamais voir, et des exemples d'articles notés.
// Fichier lisible et modifiable à la main : <home>/veille/preferences.json.
import { readJsonFile, writeJsonAtomic } from "@floppy/core";
import { norm } from "./pretri.ts";

export interface Prefs {
  /** Sujets à mettre en avant. */
  aime: string[];
  /** Sujets à noter plus bas. */
  evite: string[];
  /** Mots ou expressions : articles retirés en code, avant le modèle. */
  bannis: string[];
  /** Articles notés par l'utilisateur (les 20 derniers). */
  exemples: { titre: string; avis: "+" | "-"; date: string }[];
}

export interface PrefsFile {
  global: Prefs;
  interets: Record<string, Prefs>;
}

const MAX_EXEMPLES = 20;

export function emptyPrefs(): Prefs {
  return { aime: [], evite: [], bannis: [], exemples: [] };
}

export class PrefsStore {
  readonly file: string;
  data: PrefsFile;

  constructor(file: string) {
    this.file = file;
    const raw: Partial<PrefsFile> = readJsonFile<Partial<PrefsFile>>(file) ?? {};
    this.data = { global: fill(raw.global), interets: Object.fromEntries(Object.entries(raw.interets ?? {}).map(([k, v]) => [k, fill(v)])) };
  }

  of(interet?: string): Prefs {
    if (!interet) return this.data.global;
    return (this.data.interets[interet] ??= emptyPrefs());
  }

  /** Préférences globales + celles du centre d'intérêt. */
  merged(interet: string): Prefs {
    const g = this.data.global;
    const i = this.data.interets[interet] ?? emptyPrefs();
    return { aime: [...g.aime, ...i.aime], evite: [...g.evite, ...i.evite], bannis: [...g.bannis, ...i.bannis], exemples: [...i.exemples, ...g.exemples].slice(0, MAX_EXEMPLES) };
  }

  /** Ajoute un sujet à une liste (sans doublon) et le retire des listes contraires. Rend vrai si quelque chose a changé. */
  addTopic(list: "aime" | "evite" | "bannis", sujet: string, interet?: string): boolean {
    const p = this.of(interet);
    const s = sujet.trim();
    if (!s) return false;
    const same = (x: string) => norm(x) === norm(s);
    for (const other of ["aime", "evite", "bannis"] as const) if (other !== list) p[other] = p[other].filter((x) => !same(x));
    if (p[list].some(same)) { this.save(); return false; }
    p[list].push(s);
    this.save();
    return true;
  }

  addExample(titre: string, avis: "+" | "-", interet?: string): void {
    const p = this.of(interet);
    p.exemples = [{ titre, avis, date: new Date().toISOString() }, ...p.exemples.filter((e) => e.titre !== titre)].slice(0, MAX_EXEMPLES);
    this.save();
  }

  /** Retire un sujet de toutes les listes (« en fait, la crypto ça va »). */
  forget(sujet: string, interet?: string): boolean {
    const p = this.of(interet);
    const before = p.aime.length + p.evite.length + p.bannis.length;
    for (const l of ["aime", "evite", "bannis"] as const) p[l] = p[l].filter((x) => norm(x) !== norm(sujet));
    const changed = p.aime.length + p.evite.length + p.bannis.length !== before;
    if (changed) this.save();
    return changed;
  }

  save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

function fill(p: Partial<Prefs> | undefined): Prefs {
  const strs = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  return {
    aime: strs(p?.aime), evite: strs(p?.evite), bannis: strs(p?.bannis),
    exemples: Array.isArray(p?.exemples) ? p!.exemples.filter((e) => e && typeof e.titre === "string" && (e.avis === "+" || e.avis === "-")) : [],
  };
}
