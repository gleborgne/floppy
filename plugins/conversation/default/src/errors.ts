// Pourquoi un tour a échoué : le message dit la cause et ce qu'il y a à faire, au lieu d'un « je n'arrive pas à réfléchir ».
import { tr } from "@floppy/core";
import { PHRASES } from "./model.ts";

/** Le mode demande un cerveau et aucun n'est actif. */
export class NoBrainError extends Error {
  constructor() { super("Aucun cerveau actif pour répondre en cascade ou en texte."); this.name = "NoBrainError"; }
}

export type TurnErrorKind = "no_brain" | "stalled" | "network" | "other";

const NETWORK_CODES = /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/;
const NETWORK_WORDS = /fetch failed|network|econnrefused|econnreset|enotfound|etimedout|socket hang up|timed? ?out|timeout/i;

/** Une erreur réseau : fetch échoué, connexion refusée ou coupée, délai dépassé (cause comprise). */
export function isNetworkError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    if (typeof cur !== "object") return NETWORK_WORDS.test(String(cur));
    const err = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (err.name === "TimeoutError") return true;
    if (typeof err.code === "string" && NETWORK_CODES.test(err.code)) return true;
    if (typeof err.message === "string" && NETWORK_WORDS.test(err.message)) return true;
    cur = err.cause;
  }
  return false;
}

/** Classe l'erreur d'un tour. `stalled` : le silence du cerveau a déclenché l'arrêt (withIdleTimeout). */
export function classifyTurnError(e: unknown, stalled: boolean): TurnErrorKind {
  if (e instanceof NoBrainError) return "no_brain";
  if (stalled) return "stalled";
  if (isNetworkError(e)) return "network";
  return "other";
}

/** Phrase du cas, dans la langue de l'assistant ; `other` est l'`error_reply` de l'utilisateur ou la phrase par défaut. */
export function errorPhrase(kind: TurnErrorKind, lang: "fr" | "en", other: string): string {
  return kind === "other" ? other : tr(kind === "no_brain" ? PHRASES.error_no_brain : kind === "stalled" ? PHRASES.error_stalled : PHRASES.error_network, lang);
}
