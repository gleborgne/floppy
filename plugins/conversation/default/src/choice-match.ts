// Réponse courte à un choix dans une liste (« 2 », « la deuxième », « the last one », « le rouge »), à la voix ou tapée.
// Bilingue : les mots français et anglais sont toujours acceptés. Mots comparés sans accents (comme `text.ts`).
import { stripWakeWord, tokens } from "./text.ts";

/** Option à reconnaître : son id est rendu, son libellé est dit dans la langue de l'assistant. */
export interface ChoiceOption { id: string; label: string }

const STRONG: Record<string, number> = {
  deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10,
  premier: 1, premiere: 1, deuxieme: 2, second: 2, seconde: 2, troisieme: 3, quatrieme: 4, cinquieme: 5, sixieme: 6,
  septieme: 7, huitieme: 8, neuvieme: 9, dixieme: 10,
  first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
/** « un » / « one » : trop courants pour compter dans une phrase (« the second one »), valables seulement seuls. */
const WEAK = ["un", "une", "one"];
const LAST = ["dernier", "derniere", "last"];
/** Mots de politesse, d'article et de demande qui entourent le choix sans le nommer. */
const FILLERS = new Set(["le", "la", "les", "l", "the", "a", "an", "option", "options", "choix", "choice", "numero", "number", "n", "no", "je", "j", "i", "prends", "prend", "prendre",
  "choisis", "choisi", "choisir", "take", "pick", "choose", "want", "veux", "voudrais", "would", "like", "will", "ll", "go", "with", "ones", "please", "stp", "svp", "s", "il", "te", "plait",
  "vous", "ce", "cette", "celui", "celle", "ci", "du", "de", "des", "d", "et", "ou", "and", "or", "of", "to", "on", "ok", "alors", "bon", "euh", "um", "uh", "one", "un", "une", "that", "this"]);

const MAX_INDEX = 20;
const MAX_WORDS = 6;
const MAX_WORDS_LABEL = 8;

function contains(t: string[], phrase: string[]): boolean {
  return phrase.length > 0 && t.some((_, i) => phrase.every((x, j) => t[i + j] === x));
}

/**
 * Quelle option l'énoncé désigne-t-il ? Rend son id, ou `undefined` (ambigu, hors liste, sans rapport, trop long :
 * l'énoncé est alors traité normalement). Ordre : libellé cité en entier, puis rang (chiffre, nombre, ordinal,
 * premier / dernier), puis mots de l'énoncé tous présents dans le libellé d'une seule option.
 */
export function matchChoice(text: string, wakeWords: string[], options: ChoiceOption[]): string | undefined {
  const wake = tokens(wakeWords.join(" "));
  const t = tokens(stripWakeWord(text, wakeWords)).filter((x) => !wake.includes(x));
  if (!t.length || t.length > MAX_WORDS_LABEL || !options.length) return undefined;
  const labels = options.map((o) => tokens(o.label));
  // 1. Le libellé entier est dans l'énoncé (le plus long gagne ; à égalité, ambigu).
  const named = labels.map((l, i) => ({ i, n: contains(t, l) ? l.length : 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (named.length && (named.length === 1 || named[0]!.n > named[1]!.n)) return options[named[0]!.i]!.id;
  if (named.length) return undefined;
  // 2. Le rang : une seule désignation, dans la liste.
  if (t.length <= MAX_WORDS) {
    const ranks = new Set<number>();
    for (const x of t) {
      if (/^\d{1,3}$/.test(x)) ranks.add(Number(x));
      else if (x in STRONG) ranks.add(STRONG[x]!);
      else if (LAST.includes(x)) ranks.add(options.length);
    }
    if (!ranks.size) {
      const rest = t.filter((x) => !FILLERS.has(x) || WEAK.includes(x));
      if (rest.length === 1 && WEAK.includes(rest[0]!)) ranks.add(1);
    }
    if (ranks.size) {
      const [rank] = [...ranks];
      return ranks.size === 1 && rank! >= 1 && rank! <= Math.min(MAX_INDEX, options.length) ? options[rank! - 1]!.id : undefined;
    }
  }
  // 3. Un mot distinctif d'un libellé (« le rouge » pour « Rouge vif »), si une seule option le contient.
  const content = t.filter((x) => !FILLERS.has(x) && x.length > 1);
  if (!content.length) return undefined;
  const hit = labels.map((l, i) => ({ i, ok: content.every((x) => l.includes(x)) })).filter((x) => x.ok);
  return hit.length === 1 ? options[hit[0]!.i]!.id : undefined;
}

const NUMBER_WORDS = {
  fr: ["un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"],
  en: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
};

/** Phrase dite pour une liste : « Quel fruit ? Un : pomme, deux : poire. » (chiffres au-delà de dix). Les détails ne sont pas dits. */
export function choicePrompt(title: string, options: { label: string }[], lang: "fr" | "en"): string {
  const words = NUMBER_WORDS[lang];
  const list = options.map((o, i) => `${words[i] ?? String(i + 1)} : ${o.label}`).join(", ");
  const head = title.trim();
  return `${head}${head && !/[.!?…:]$/.test(head) ? "." : ""} ${list}.`.trim();
}
