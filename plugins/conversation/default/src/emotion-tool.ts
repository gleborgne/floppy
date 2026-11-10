// Outil d'émotion du mode Live (réservé à ce mode) : un modèle qui parle lui-même ne peut pas écrire « [content] »,
// il dit son émotion en appelant cet outil. Il n'est JAMAIS enregistré dans ctx.tools : les cerveaux du mode séparé
// ne le voient pas ; LiveConversation l'ajoute aux outils de la session et répond lui-même à l'appel.
import type { ToolInfo } from "@floppy/core";
import { PROMPT_EMOTIONS_EN } from "@floppy/contracts";
import { INTENSITY_LIGHT, INTENSITY_STRONG, type Emotion } from "@floppy/protocol";

export const EMOTION_TOOL = "exprimer_emotion";

/** Déclaration donnée au modèle Live (description lue seulement par lui : en français). */
export function emotionToolInfo(): ToolInfo {
  return {
    name: EMOTION_TOOL,
    description: "Montre ton émotion sur le visage et dans la voix, en silence. À appeler quand ton émotion est claire, au plus une fois par réponse, avant ou pendant que tu parles. Ne la mentionne jamais à l'oral.",
    inputSchema: { type: "object", properties: {
      emotion: { type: "string", enum: [...PROMPT_EMOTIONS_EN], description: "Ton émotion." },
      intensite: { type: "string", enum: ["legere", "normale", "forte"], description: "Facultatif : normale par défaut." },
    }, required: ["emotion"] },
    level: "read", source: "live",
  };
}

/** Lit un appel ; rend rien si l'émotion n'est pas l'une des douze connues (l'appel reste répondu, sans effet). */
export function parseEmotionCall(args: Record<string, unknown>): { emotion: Emotion; intensity?: number } | undefined {
  const emotion = String(args.emotion ?? "").trim().toLowerCase();
  if (!(PROMPT_EMOTIONS_EN as readonly string[]).includes(emotion)) return undefined;
  const level = String(args.intensite ?? "").trim().toLowerCase();
  const intensity = level === "forte" ? INTENSITY_STRONG : level === "legere" ? INTENSITY_LIGHT : undefined;
  return intensity === undefined ? { emotion: emotion as Emotion } : { emotion: emotion as Emotion, intensity };
}
