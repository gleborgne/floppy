// Préférences de la veille : ce que l'utilisateur aime, évite, ne veut plus jamais voir, et des exemples d'articles notés.
// Fichier lisible et modifiable à la main : <home>/watch/preferences.json.
import { readJsonFile, writeJsonAtomic } from "@floppy/core";
import { norm } from "./presort.ts";

export interface Prefs {
  /** Sujets à mettre en avant. */
  likes: string[];
  /** Sujets à noter plus bas. */
  avoids: string[];
  /** Mots ou expressions : articles retirés en code, avant le modèle. */
  banned: string[];
  /** Articles notés par l'utilisateur (les 20 derniers). */
  examples: { title: string; feedback: "+" | "-"; date: string }[];
}

export interface PrefsFile {
  global: Prefs;
  interests: Record<string, Prefs>;
}

const MAX_EXAMPLES = 20;

export function emptyPrefs(): Prefs {
  return { likes: [], avoids: [], banned: [], examples: [] };
}

export class PrefsStore {
  readonly file: string;
  data: PrefsFile;

  constructor(file: string) {
    this.file = file;
    const raw: Partial<PrefsFile> = readJsonFile<Partial<PrefsFile>>(file) ?? {};
    this.data = { global: fill(raw.global), interests: Object.fromEntries(Object.entries(raw.interests ?? {}).map(([k, v]) => [k, fill(v)])) };
  }

  of(interest?: string): Prefs {
    if (!interest) return this.data.global;
    return (this.data.interests[interest] ??= emptyPrefs());
  }

  /** Préférences globales + celles du centre d'intérêt. */
  merged(interest: string): Prefs {
    const g = this.data.global;
    const i = this.data.interests[interest] ?? emptyPrefs();
    return { likes: [...g.likes, ...i.likes], avoids: [...g.avoids, ...i.avoids], banned: [...g.banned, ...i.banned], examples: [...i.examples, ...g.examples].slice(0, MAX_EXAMPLES) };
  }

  /** Ajoute un sujet à une liste (sans doublon) et le retire des listes contraires. Rend vrai si quelque chose a changé. */
  addTopic(list: "likes" | "avoids" | "banned", sujet: string, interest?: string): boolean {
    const p = this.of(interest);
    const s = sujet.trim();
    if (!s) return false;
    const same = (x: string) => norm(x) === norm(s);
    for (const other of ["likes", "avoids", "banned"] as const) if (other !== list) p[other] = p[other].filter((x) => !same(x));
    if (p[list].some(same)) { this.save(); return false; }
    p[list].push(s);
    this.save();
    return true;
  }

  addExample(title: string, feedback: "+" | "-", interest?: string): void {
    const p = this.of(interest);
    p.examples = [{ title, feedback, date: new Date().toISOString() }, ...p.examples.filter((e) => e.title !== title)].slice(0, MAX_EXAMPLES);
    this.save();
  }

  /** Retire un sujet de toutes les listes (« en fait, la crypto ça va »). */
  forget(sujet: string, interest?: string): boolean {
    const p = this.of(interest);
    const before = p.likes.length + p.avoids.length + p.banned.length;
    for (const l of ["likes", "avoids", "banned"] as const) p[l] = p[l].filter((x) => norm(x) !== norm(sujet));
    const changed = p.likes.length + p.avoids.length + p.banned.length !== before;
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
    likes: strs(p?.likes), avoids: strs(p?.avoids), banned: strs(p?.banned),
    examples: Array.isArray(p?.examples) ? p!.examples.filter((e) => e && typeof e.title === "string" && (e.feedback === "+" || e.feedback === "-")) : [],
  };
}
