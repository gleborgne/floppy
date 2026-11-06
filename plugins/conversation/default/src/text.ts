// Outils de texte de la conversation : mot d'activation, oui / non, phrases.
// Reconnaissance bilingue : les mots français et anglais sont toujours acceptés (sans risque de confusion),
// quelle que soit la langue de l'assistant.

import { allTexts, tr, type Text } from "@floppy/core";
export function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function tokens(s: string): string[] {
  return norm(s).match(/[a-z0-9]+/g) ?? [];
}

/** Le mot d'activation est-il dans la phrase ? (comparaison par mots, sans accents ; cascade/pipeline.py) */
export function hasWakeWord(text: string, words: string[]): boolean {
  const t = tokens(text);
  return words.some((w) => {
    const wt = tokens(w);
    return wt.length > 0 && t.some((_, i) => wt.every((x, j) => t[i + j] === x));
  });
}

/** Retire le mot d'activation et la ponctuation qui le suit (« Floppy, quelle heure… » → « quelle heure… »). */
export function stripWakeWord(text: string, words: string[]): string {
  let out = text;
  for (const w of words) {
    const re = new RegExp(`^\\s*(?:(?:hey|hé|eh|ok|okay|dis|salut|hi|hello)\\s+)?${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s,.!?:;-]*`, "i");
    out = out.replace(re, "");
  }
  return out.trim();
}

const YES = ["oui", "ouais", "ok", "okay", "d accord", "dacord", "vas y", "vas-y", "go", "bien sur", "c est bon", "accepte", "valide", "confirme", "yes",
  "yeah", "yep", "yup", "sure", "of course", "go ahead", "do it", "alright", "all right", "approve", "approved", "confirm", "confirmed", "accept", "fine"];
const NO = ["non", "annule", "refuse", "laisse tomber", "pas maintenant", "stop", "no", "surtout pas",
  "nope", "nah", "cancel", "never mind", "nevermind", "forget it", "not now", "don t", "do not", "deny", "decline", "no way", "of course not", "abort"];

/** Réponse courte à une demande d'accord : true (oui), false (non) ou undefined (autre chose). */
export function yesNo(text: string, wakeWords: string[]): boolean | undefined {
  const t = tokens(stripWakeWord(text, wakeWords)).filter((x) => !tokens(wakeWords.join(" ")).includes(x));
  if (!t.length || t.length > 5) return undefined;
  const s = " " + t.join(" ") + " ";
  const has = (list: string[]) => list.some((w) => s.includes(` ${w.replace(/-/g, " ")} `));
  if (has(NO)) return false;
  if (has(YES)) return true;
  return undefined;
}

const SLEEP = ["dors", "dodo", "chut", "tais toi", "silence", "va dormir", "mets toi en veille", "en veille",
  "go to sleep", "go sleep", "sleep now", "sleep mode", "shut up", "be quiet", "hush", "stand by", "standby"];
/** Mots anglais trop courants pour être cherchés dans la phrase : seulement s'ils sont dits seuls (« Floppy, sleep »). */
const SLEEP_ALONE = ["sleep", "quiet", "silence"];

/** « Floppy, réveille-toi » / « wake up » : une phrase de réveil sans autre demande. */
export function isWakeUpPhrase(text: string): boolean {
  return /reveill?e|debout|tu es la|wake up|are you there|you there/.test(norm(text));
}
export function isSleepCommand(text: string, wakeWords: string[]): boolean {
  const t = tokens(stripWakeWord(text, wakeWords));
  if (!t.length || t.length > 5) return false;
  const s = " " + t.join(" ") + " ";
  return SLEEP.some((w) => s.includes(` ${w} `)) || SLEEP_ALONE.includes(t.join(" "));
}

/**
 * Découpe un flux de texte en phrases à dire dès qu'elles sont complètes (cascade/pipeline.py).
 * Après la 1re phrase, un morceau de MIN_WORDS mots ou moins attend la phrase suivante :
 * la voix qui lit de tout petits bouts sonne hachée. La 1re phrase part toujours seule (latence).
 */
export class SentenceSplitter {
  private buf = "";
  private first = true;
  private static END = /([.!?…;:])\s/g;
  private static CLAUSE = /(,)\s/g;
  private static FIRST_MIN = 20;
  static MIN_WORDS = 3;

  /** Position de la prochaine coupure à partir de `from`, ou -1. */
  private nextCut(from: number): number {
    SentenceSplitter.END.lastIndex = from;
    const m = SentenceSplitter.END.exec(this.buf);
    if (m) return m.index + m[1]!.length;
    if (this.first && from === 0) {
      // Le 1er morceau peut s'arrêter à une virgule : la voix démarre plus tôt.
      SentenceSplitter.CLAUSE.lastIndex = SentenceSplitter.FIRST_MIN;
      const c = SentenceSplitter.CLAUSE.exec(this.buf);
      return c ? c.index + 1 : -1;
    }
    return -1;
  }

  push(delta: string): string[] {
    return this.pushParts(delta).map((p) => p.text);
  }

  flush(): string[] {
    return this.flushParts().map((p) => p.text);
  }

  /**
   * Comme push(), et dit si la phrase ouvre un nouveau paragraphe (retour à la ligne avant elle).
   * La voix marque alors une pause : sans elle, deux paragraphes s'enchaînent comme une seule phrase.
   */
  pushParts(delta: string): SpokenPart[] {
    this.buf += delta;
    const out: SpokenPart[] = [];
    let from = 0;
    for (;;) {
      const cut = this.nextCut(from);
      if (cut < 0) break;
      const raw = this.buf.slice(0, cut);
      const s = clean(raw);
      if (s && !this.first && tokens(s).length <= SentenceSplitter.MIN_WORDS) { from = cut; continue; } // trop court : on attend la suite
      const rest = this.buf.slice(cut);
      const lead = this.gap + /^\s*/.exec(raw)![0];
      this.gap = /^\s*/.exec(rest)![0];
      this.buf = rest.slice(this.gap.length);
      from = 0;
      if (s) { out.push({ text: s, paragraph: !this.first && lead.includes("\n") }); this.first = false; }
      else this.gap = lead + this.gap; // morceau vide : on garde son retour à la ligne pour la phrase suivante
    }
    return out;
  }

  flushParts(): SpokenPart[] {
    const lead = this.gap + /^\s*/.exec(this.buf)![0];
    const s = clean(this.buf);
    this.buf = "";
    this.gap = "";
    return s ? [{ text: s, paragraph: !this.first && lead.includes("\n") }] : [];
  }

  /** Blancs retirés après la dernière coupure : ils peuvent contenir le retour à la ligne du paragraphe suivant. */
  private gap = "";
}

export interface SpokenPart { text: string; paragraph: boolean }

export function clean(s: string): string {
  return s.replace(/[*_#`>|]/g, "").replace(/\s+/g, " ").trim();
}

/** Choix possible d'un réglage à choix (forme minimale de SettingInfo, pour rester indépendant du noyau). */
export interface QuickSettingInfo {
  key: string;
  type: string;
  label?: Text;
  /** Rôle déclaré (ex. "brain.main") : donne des mots-clés génériques, sans connaître la clé du réglage. */
  role?: string;
  options?: { value: string; label: Text; aliases?: string[]; slow?: boolean }[];
}

const CHANGE_VERBS = ["passe", "passer", "bascule", "basculer", "reviens", "revenir", "retourne", "change", "changer", "mets", "met", "prends", "prend", "utilise", "choisis", "active",
  "switch", "use", "set", "select", "pick", "go", "activate"];
/** Mots qui désignent un rôle de réglage (le réglage est reconnu par son rôle, pas par sa clé). */
const ROLE_HINTS: Record<string, string[]> = { "brain.main": ["cerveau", "modele", "llm", "ia", "intelligence", "brain", "model"] };

/** Mots qui désignent un réglage : mots de son libellé (toutes langues) + mots de son rôle. */
function hintWords(s: QuickSettingInfo): string[] {
  const label = s.label ? allTexts(s.label).flatMap(tokens) : [];
  return [...label, ...(s.role ? ROLE_HINTS[s.role] ?? [] : [])].filter((w) => w.length > 2);
}

/**
 * Voie rapide, sans LLM : « passe sur Gemma », « reviens sur la voix de femme », « bascule sur Qwen 9B ».
 * Phrase courte qui commence par un verbe de changement et nomme un choix connu d'un réglage à choix.
 * Le choix le plus long gagne ; si deux réglages différents correspondent autant, on laisse le cerveau décider.
 * En anglais aussi : « switch to Gemma », « use Qwen 9B ». `lang` : langue du libellé rendu (celle de l'assistant).
 */
export function matchQuickSetting(text: string, wakeWords: string[], settings: QuickSettingInfo[], lang = "fr"): { key: string; value: string; label: string; slow: boolean } | undefined {
  const t = tokens(stripWakeWord(text, wakeWords));
  if (!t.length || t.length > 9) return undefined;
  if (!t.slice(0, 3).some((w) => CHANGE_VERBS.includes(w))) return undefined;
  const hinted = settings.filter((s) => hintWords(s).some((w) => t.includes(w))).map((s) => s.key);
  const contains = (phrase: string): number => {
    const p = tokens(phrase);
    if (!p.length) return 0;
    return t.some((_, i) => p.every((x, j) => t[i + j] === x)) ? p.length : 0;
  };
  let best: { key: string; value: string; label: string; slow: boolean; score: number } | undefined;
  let tie = false;
  for (const s of settings) {
    if (s.type !== "enum" || !s.options) continue;
    if (hinted.length && !hinted.includes(s.key)) continue;
    for (const o of s.options) {
      const score = Math.max(...allTexts(o.label).map(contains), contains(o.value), ...(o.aliases ?? []).map(contains));
      if (!score) continue;
      if (!best || score > best.score) { best = { key: s.key, value: o.value, label: tr(o.label, lang), slow: !!o.slow, score }; tie = false; }
      else if (score === best.score && best.key !== s.key) tie = true;
    }
  }
  if (!best || tie) return undefined;
  return { key: best.key, value: best.value, label: best.label, slow: best.slow };
}
