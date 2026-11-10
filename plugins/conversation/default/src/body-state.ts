// État d'un corps : ce que les drapeaux disent de l'état montré, « peut-on écouter sans mot d'activation »,
// et la table des transitions autorisées. La table est un filet de diagnostic : `setState` journalise une transition
// absente (état « state.unexpected »), il ne la refuse jamais.
import type { BodyState } from "@floppy/protocol";

/** Les drapeaux d'un corps qui décident de son état. */
export interface BodyFlags {
  muted: boolean;
  /** Un tour de conversation est en cours. */
  turn: boolean;
  /** Une initiative (annonce, voie rapide) est en cours de lecture. */
  init: boolean;
  /** Le corps joue de l'audio. */
  playing: boolean;
  /** Bouton parler maintenu. */
  ptt?: boolean;
  /** Fin de la fenêtre d'écoute libre (ms epoch). */
  awakeUntil: number;
}

/** Une phrase entendue maintenant est adressée à Floppy sans mot d'activation (bouton parler ou écoute libre). */
export function canListenWithoutWake(f: Pick<BodyFlags, "muted" | "ptt" | "awakeUntil">, now: number): boolean {
  return !!f.ptt || (!f.muted && now <= f.awakeUntil);
}

/** État pris quand l'écoute libre (re)commence : « sleep » si le corps est muet, sinon « listening ». */
export function openListeningState(f: Pick<BodyFlags, "muted">): BodyState {
  return f.muted ? "sleep" : "listening";
}

/**
 * Transitions autorisées, de l'état actuel vers le suivant. Rester dans le même état et passer en veille
 * (muet, « dors », corps débranché) sont toujours permis ; le reste est listé ici.
 */
export const TRANSITIONS: Readonly<Record<BodyState, readonly BodyState[]>> = {
  // Réveil : mot d'activation, saisie, bouton parler ou fin de la veille.
  sleep: ["idle", "listening", "thinking"],
  // Repos : on l'appelle, on lui écrit, ou une annonce est dite.
  idle: ["listening", "thinking", "speaking"],
  // Écoute : une demande part au cerveau, l'écoute se ferme, une annonce est dite.
  listening: ["idle", "thinking", "speaking"],
  // Réflexion : la réponse est dite, ou le tour finit (voix : écoute libre ; texte : repos).
  thinking: ["speaking", "listening", "idle"],
  // Parole : fin de tour (écoute libre ou repos), ou une nouvelle demande coupe la réponse.
  speaking: ["listening", "idle", "thinking"],
};

/** Vrai si passer de `from` à `to` est prévu. */
export function isExpectedTransition(from: BodyState, to: BodyState): boolean {
  return from === to || to === "sleep" || TRANSITIONS[from].includes(to);
}
