// Étiquettes d'émotion des cerveaux CLI (Claude, Codex, Antigravity) : même mécanisme que le cerveau aisdk.
// Le prompt demande « [content] C'est fait. » ; le texte en flux passe par EmotionTagFilter (dans @floppy/contracts) :
// `text` ne contient jamais d'étiquette, les événements `emotion` sortent dans l'ordre, à leur place dans le texte.
import { type BrainEvent } from "@floppy/contracts";
import { EmotionTagFilter, emotionTagPrompt, filterEvents } from "@floppy/toolkit";

/** Ajoute la consigne d'étiquettes au prompt d'un cerveau CLI (langue de l'assistant), sauf si le réglage est coupé. */
export function withEmotionTags(prompt: string, enabled: boolean, lang: string | undefined): string {
  return enabled ? `${prompt}\n\n${emotionTagPrompt(lang)}` : prompt;
}

/** Le texte d'une réponse en flux, filtré (ou laissé tel quel si les étiquettes sont coupées). Un par tour. */
export class ReplyTags {
  private readonly filter: EmotionTagFilter | undefined;
  constructor(enabled: boolean) { this.filter = enabled ? new EmotionTagFilter() : undefined; }

  /** Un morceau de texte du CLI : le texte sans étiquette et les émotions, dans l'ordre. */
  push(delta: string): BrainEvent[] {
    return this.filter ? filterEvents(this.filter.push(delta)) : [{ type: "text", delta }];
  }
  /** Nouveau segment (après un outil, un nouvel élément ou une nouvelle étape) : rend ce qui était en attente. */
  newSegment(): BrainEvent[] { return this.filter ? filterEvents(this.filter.newSegment()) : []; }
  /** Fin du tour : rend ce qui était en attente. */
  end(): BrainEvent[] { return this.filter ? filterEvents(this.filter.end()) : []; }
}
