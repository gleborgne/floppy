// Ce que la page partage avec le noyau : l'état décidé par lui et par l'utilisateur, et le lien (MessagePort).
// Seul le protocole (app-protocol.ts) écrit la session et attache le port ; les autres modules la lisent
// par `SessionView` et envoient par `Link.send`.
import type { BodyToKernel } from "@floppy/protocol";
import type { CardEl } from "./app-dom.ts";

export interface Session {
  /** État de Floppy (message state du noyau). Au démarrage il dort jusqu'au premier état envoyé. */
  state: string;
  /** Mode muet (raccourci « mute ») : le micro n'envoie rien au noyau. */
  muted: boolean;
  /** Parler maintenu (raccourci « ptt »). */
  pttOn: boolean;
  /** Dictée en cours : le micro écoute même quand Floppy dort. */
  dictating: boolean;
  /** Demandes d'accord affichées, par id. */
  approvals: Map<string, CardEl>;
}
/** Lecture seule de la session, pour les modules qui ne l'écrivent pas. */
export interface SessionView {
  readonly state: string;
  readonly muted: boolean;
  readonly pttOn: boolean;
  readonly dictating: boolean;
  readonly approvals: ReadonlyMap<string, CardEl>;
}
export const createSession = (): Session => ({ state: "sleep", muted: false, pttOn: false, dictating: false, approvals: new Map() });

/** Le lien avec le noyau : un MessagePort, { j: <message JSON> } vers le noyau, { a: <audio micro> }. */
export interface Link {
  readonly port: MessagePort | null;
  /** Seul le protocole l'appelle (nouvelle connexion). */
  attach(port: MessagePort | null): void;
  send(msg: BodyToKernel): void;
}
export function createLink(): Link {
  let port: MessagePort | null = null;
  return {
    get port() { return port; },
    attach(p) { port = p; },
    send(msg) { port?.postMessage({ j: msg }); },
  };
}
