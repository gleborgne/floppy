// Retire les étiquettes d'émotion d'un texte en flux (« [joie] Bonne nouvelle… [surpris] ah ! ») et les rend
// comme des événements à part, à leur place dans le texte. Le texte lu à voix haute ne contient jamais l'étiquette.
// - En tête de réponse (ou de segment, après un outil) : comme avant, un mot court inconnu entre crochets est retiré.
// - Au milieu : seule une vraie émotion est retirée ; « [1] » ou « [note] » restent dans le texte.
// - Intensité : « [joie+] », « [content-] », « [très surpris] » (voir parseEmotionTag).
// Partagé par tous les cerveaux texte (aisdk, Claude, Codex, Antigravity) : ils n'importent jamais un autre plugin.
import { parseEmotionTag, PROMPT_EMOTIONS_FR, type Emotion } from "@floppy/protocol";
import type { BrainEvent } from "./brain.ts";

export type FilterOut = { text?: string; emotion?: Emotion; intensity?: number };

/** Longueur maximale d'une étiquette : au-delà, le « [ » est du texte ordinaire. */
const MAX_TAG = 24;
/** Mot court inconnu entre crochets, retiré en tête de segment (sauf s'il est suivi de « ( » : lien markdown). */
const HEAD_WORD = /^[\p{L} -]{2,16}$/u;

export class EmotionTagFilter {
  private buf = "";
  /** Encore au début du segment (rien de lisible n'est sorti). */
  private head = true;
  /** Dernier caractère sorti (pour ne pas doubler ni coller les espaces autour d'une étiquette retirée). */
  private lastChar = "";

  /** Nouveau segment de texte (après un appel d'outil, l'étiquette de tête peut revenir). Rend ce qui était en attente. */
  newSegment(): FilterOut[] {
    const out = this.end();
    this.head = true;
    return out;
  }

  push(delta: string): FilterOut[] {
    this.buf += delta;
    const out: FilterOut[] = [];
    for (;;) {
      const open = this.buf.indexOf("[");
      if (open < 0) { this.text(out, this.buf); this.buf = ""; break; }
      if (open > 0) { this.text(out, this.buf.slice(0, open)); this.buf = this.buf.slice(open); }
      const close = this.buf.indexOf("]");
      if (close < 0) {
        if (this.buf.length > MAX_TAG) { this.text(out, this.buf[0]!); this.buf = this.buf.slice(1); continue; }
        break; // on attend la fin de l'étiquette
      }
      const word = this.buf.slice(1, close);
      const after = this.buf.slice(close + 1);
      const tag = close <= MAX_TAG ? parseEmotionTag(word) : undefined;
      if (tag) {
        out.push(tag.intensity === undefined ? { emotion: tag.emotion } : { emotion: tag.emotion, intensity: tag.intensity });
        // L'espace en trop disparaît : « bien [joie] oui » → « bien oui », « [joie] Oui » → « Oui ».
        this.buf = this.head || /\s/.test(this.lastChar) ? after.replace(/^\s+/, "") : after;
        continue;
      }
      if (this.head && HEAD_WORD.test(word)) {
        // « [Guide](url) » est un lien markdown : le libellé reste. On attend le caractère suivant pour le savoir.
        if (after === "") break;
        if (!after.startsWith("(")) { this.buf = after.replace(/^\s+/, ""); continue; }
      }
      this.text(out, this.buf.slice(0, close + 1));
      this.buf = after;
    }
    return out;
  }

  /** Fin du flux : rend ce qui restait en attente. */
  end(): FilterOut[] {
    const out: FilterOut[] = [];
    // Un mot inconnu seul en tête, sans suite : retiré comme avant (on ne saura jamais si c'était un lien).
    if (this.head && this.buf.startsWith("[") && this.buf.endsWith("]") && HEAD_WORD.test(this.buf.slice(1, -1))) this.buf = "";
    this.text(out, this.buf);
    this.buf = "";
    return out;
  }

  private text(out: FilterOut[], s: string): void {
    if (!s) return;
    if (this.head) {
      s = s.replace(/^\s+/, "");
      if (!s) return;
      this.head = false;
    }
    this.lastChar = s.at(-1)!;
    const lastItem = out.at(-1);
    if (lastItem?.text !== undefined && !lastItem.emotion) lastItem.text += s;
    else out.push({ text: s });
  }
}

/** Les événements d'un morceau filtré, dans l'ordre : une émotion à sa place dans le texte, jamais d'étiquette dans `text`. */
export function filterEvents(outs: FilterOut[]): BrainEvent[] {
  const events: BrainEvent[] = [];
  for (const o of outs) {
    if (o.emotion) events.push({ type: "emotion", emotion: o.emotion, ...(o.intensity === undefined ? {} : { intensity: o.intensity }) });
    if (o.text) events.push({ type: "text", delta: o.text });
  }
  return events;
}

/** Étiquettes d'émotion données au cerveau en anglais : les noms stables du protocole (emotionFromWord les lit). */
export const PROMPT_EMOTIONS_EN = ["happy", "joy", "laugh", "love", "proud", "sad", "sorry", "surprised", "confused", "mischief", "curious", "annoyed"];

/** Consigne d'étiquettes d'émotion à ajouter au prompt d'un cerveau (langue de l'assistant : « en », sinon français). */
export function emotionTagPrompt(lang: string | undefined): string {
  if (lang === "en") {
    return [
      `Start your answer with your emotion in square brackets, among: ${PROMPT_EMOTIONS_EN.map((e) => `[${e}]`).join(" ")}. Example: "[happy] Done."`,
      `If your emotion changes during the answer, put a tag again at that point: "[happy] Done. [mischief] And I even tidied up your desk." Add + for a strong emotion ([joy+]) and - for a light one ([happy-]). No more than one tag per sentence.`,
    ].join("\n");
  }
  return [
    `Commence ta réponse par ton émotion entre crochets, parmi : ${PROMPT_EMOTIONS_FR.map((e) => `[${e}]`).join(" ")}. Exemple : « [content] C'est fait. »`,
    `Si ton émotion change en cours de réponse, remets une étiquette à cet endroit : « [content] C'est fait. [malicieux] Et j'ai même rangé ton bureau. » Ajoute + pour une émotion forte ([joie+]) et - pour une émotion légère ([content-]). Pas plus d'une étiquette par phrase.`,
  ].join("\n");
}
