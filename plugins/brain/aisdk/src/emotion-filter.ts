// Retire les étiquettes d'émotion d'un texte en flux (« [joie] Bonne nouvelle… [surpris] ah ! ») et les rend
// comme des événements à part, à leur place dans le texte. Le texte lu à voix haute ne contient jamais l'étiquette.
// - En tête de réponse (ou de segment, après un outil) : comme avant, un mot court inconnu entre crochets est retiré.
// - Au milieu : seule une vraie émotion est retirée ; « [1] » ou « [note] » restent dans le texte.
// - Intensité : « [joie+] », « [content-] », « [très surpris] » (voir parseEmotionTag).
import { parseEmotionTag, type Emotion } from "@floppy/protocol";

export type FilterOut = { text?: string; emotion?: Emotion; intensity?: number };

/** Longueur maximale d'une étiquette : au-delà, le « [ » est du texte ordinaire. */
const MAX_TAG = 24;

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
      if (this.head && /^[\p{L} -]{2,16}$/u.test(word)) { this.buf = after.replace(/^\s+/, ""); continue; }
      this.text(out, this.buf.slice(0, close + 1));
      this.buf = after;
    }
    return out;
  }

  /** Fin du flux : rend ce qui restait en attente. */
  end(): FilterOut[] {
    const out: FilterOut[] = [];
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
