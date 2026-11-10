// Devine une émotion dans un texte, par quelques mots-clés (sans LLM, instantané).
// - « user » : Floppy réagit tout de suite à ce qu'on lui dit (« merci », « bravo », « haha »…), avant que le
//   cerveau réponde. Le cerveau garde le dernier mot : son étiquette remplace la réaction.
// - « reply » : en mode Live, le modèle ne donne pas d'émotion ; on la devine dans ce qu'il dit, phrase par phrase.
import type { Emotion } from "@floppy/protocol";

export interface Guess { emotion: Emotion; intensity: number }

type Rule = [RegExp, Emotion, number];

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " ");

// L'ordre compte : la première règle qui correspond gagne.
// Mots français et anglais dans les mêmes règles : la réaction marche quelle que soit la langue de l'assistant.
const USER: Rule[] = [
  [/\b(je t aime|je t adore|t es (trop |vraiment )?(mignon|chou|adorable|genial)|i love you|i adore you|you re (so |really )?(cute|sweet|adorable|awesome))\b/, "love", 1],
  [/\b(t es (nul|bete|idiot|stupide|debile)|tu sers a rien|ta gueule|tais toi|t es lourd|you re (useless|stupid|dumb|an idiot)|you suck|shut up)\b/, "sad", 0.9],
  [/\b(ha ?ha|hi ?hi|mdr|ptdr|lol|trop drole|t es drole|so funny|you re funny|lmao)\b/, "laugh", 1],
  [/\b(bravo|felicitations|bien joue|genial|excellent|parfait|trop fort|chapeau|super boulot|well done|good job|great job|nice work|congrats|congratulations)\b/, "proud", 1],
  [/\b(merci|thanks|c est gentil|trop sympa|thank you|that s kind|so nice)\b/, "happy", 0.9],
  [/\b(waouh|wow|ouah|incroyable|dingue|c est fou|amazing|incredible|no way)\b/, "surprised", 0.9],
  [/\b(une blague|raconte moi|fais moi rire|chante|danse|a joke|tell me|make me laugh|sing|dance)\b/, "mischief", 0.8],
  [/\b(je suis (triste|fatigue|creve|deprime)|ca va pas|c est dur|journee pourrie|i m (sad|tired|exhausted|depressed)|i feel (sad|bad|down)|bad day)\b/, "sorry", 0.8],
  [/\b(bonne nuit|a demain|dodo|good night|goodnight|see you tomorrow)\b/, "sleepy", 0.6],
  [/\b(bonjour|salut|coucou|hello|bonsoir|hey|hi|good morning|good evening)\b/, "happy", 0.6],
  [/\b(pourquoi|comment ca marche|c est quoi|explique|why|how does|what is|explain)\b/, "curious", 0.6],
];

const REPLY: Rule[] = [
  [/\b(ha ?ha|hi ?hi|hihi)\b/, "laugh", 1],
  [/\b(desole|pardon|malheureusement|je n arrive pas|impossible|je ne peux pas|sorry|unfortunately|i can t|i cannot|i m unable)\b/, "sorry", 0.8],
  [/\b(oups|aie|zut|oops|whoops)\b/, "shy", 0.8],
  [/\b(bravo|felicitations|bien joue|chapeau|well done|congratulations|congrats)\b/, "proud", 1],
  [/\b(genial|super|formidable|excellent|trop bien|youpi|chouette|great|awesome|wonderful|fantastic|yay)\b/, "joy", 0.9],
  [/\b(waouh|wow|incroyable|etonnant|surprenant|amazing|incredible|surprising)\b/, "surprised", 0.9],
  [/\b(attention|danger|prudence|careful|warning)\b/, "scared", 0.5],
  [/\b(voyons|hmm|bonne question|interessant|let s see|good question|interesting)\b/, "curious", 0.7],
  [/\b(c est fait|voila|c est bon|termine|done|there you go|all set)\b/, "happy", 0.7],
];

// Mot directement nié (« pas génial », « pas très génial », « n'est plus super », « isn't great », « not so great ») :
// la règle ne compte pas, on passe aux suivantes. On n'en tire jamais l'émotion contraire.
// Le texte est déjà normalisé (sans accents ni apostrophes : « isn't » devient « isn t »).
const ADVERB = String.raw`(?: (?:tres|vraiment|trop|si|aussi|du tout|very|really|so|too|that|at all))?`;
const NEGATED = new RegExp(String.raw`(?:\b(?:pas|jamais|aucune?|not|never|no)|(?:isn|wasn|aren|weren|don|doesn|didn|can|couldn|won|wouldn|shouldn|hasn|haven|ain) t)` + ADVERB + "$");
// « plus » ne nie qu'avec « ne » devant (« n'est plus super ») : « encore plus génial » reste positif.
const NE_PLUS = new RegExp(String.raw`\b(?:ne|n)\b(?:\s+\S+){0,2}\s+plus` + ADVERB + "$");
const negated = (before: string): boolean => { const b = before.trimEnd(); return NEGATED.test(b) || NE_PLUS.test(b); };

export function guessEmotion(text: string, who: "user" | "reply"): Guess | undefined {
  const t = norm(text);
  if (!t.trim()) return undefined;
  for (const [re, emotion, intensity] of who === "user" ? USER : REPLY) {
    for (const m of t.matchAll(new RegExp(re.source, "g"))) if (!negated(t.slice(0, m.index))) return { emotion, intensity };
  }
  // Beaucoup d'enthousiasme (« !!! ») sans mot-clé.
  if (who === "reply" && /!\s*$/.test(text.trim()) && (text.match(/!/g)?.length ?? 0) >= 2) return { emotion: "excited", intensity: 0.6 };
  return undefined;
}

/** Texte en flux (Live) : rend une émotion devinée à chaque phrase complète. */
export class ReplyFeeler {
  private buf = "";
  push(delta: string): Guess | undefined {
    this.buf = (this.buf + delta).slice(-600);
    let last: Guess | undefined;
    for (;;) {
      const m = this.buf.match(/^([\s\S]*?[.!?…])(\s|$)/);
      if (!m || !m[0].length) break;
      this.buf = this.buf.slice(m[0].length);
      last = guessEmotion(m[1]!, "reply") ?? last;
    }
    return last;
  }
  reset(): void { this.buf = ""; }
}
