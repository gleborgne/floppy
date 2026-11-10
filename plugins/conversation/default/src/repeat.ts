// Commande locale « répète » : une phrase courte qui demande de redire la dernière réponse est reconnue sans modèle.
// Français et anglais toujours acceptés. Le test est volontairement strict (7 mots au plus, rien d'autre que
// des mots de politesse autour du verbe) : « répète après moi … » ou une vraie question ne doivent pas passer.
import { stripWakeWord, tokens } from "./text.ts";

/** Mots de politesse ou de liaison, sans sens propre dans la demande (formes sans accent). */
const FILLER = new Set(["tu", "vous", "peux", "peut", "pouvez", "pourrais", "pourriez", "s", "il", "te", "plait", "svp", "stp",
  "moi", "ca", "le", "la", "encore", "une", "fois", "please", "can", "could", "would", "you", "that", "it", "just", "juste", "a"]);
/** Ce qui reste une fois les mots de liaison retirés : la demande elle-même. */
const CORE = new Set(["repete", "repeter", "redis", "redire", "pardon", "comment", "repeat", "say again", "come again"]);

/** La phrase (mot d'activation compris) demande-t-elle de répéter ? */
export function isRepeatRequest(text: string, wakeWords: string[]): boolean {
  const wakeTokens = new Set(tokens(wakeWords.join(" ")));
  const t = tokens(stripWakeWord(text, wakeWords)).filter((x) => !wakeTokens.has(x));
  if (!t.length || t.length > 7) return false;
  const core = t.filter((x) => !FILLER.has(x)).join(" ");
  // « Comment ? » et « Pardon ? » ne demandent de répéter que dits seuls (« comment ça ? » demande une explication).
  if (core === "comment" || core === "pardon") return t.length === 1;
  return CORE.has(core);
}
