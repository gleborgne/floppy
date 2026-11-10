// Corps (fenêtre, robot, page web) branchés au hub, et avatars de l'app de bureau.
import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import type { Text } from "@floppy/core";

/** Hook `initiative.presented` : programmation vocale ou demande d'affichage transmise,
 * sans preuve que l'utilisateur a vu ou entendu. `completed` concerne seulement la voix. */
export interface InitiativePresented {
  origin: string;
  session?: string;
  source: string;
  key?: string;
  stage: "display-scheduled" | "scheduled" | "completed" | "interrupted";
}

/** Hook `initiative.delivery` : suivi de file uniquement, sans établir de référence parlée. */
export interface InitiativeDelivery {
  source: string;
  key?: string;
  stage: "queued" | "dropped" | "deduped";
  queueLength: number;
}

export interface BodySessionInfo {
  id: string;
  name: string;
  capabilities: Capability[];
  tools: string[];
  /** Faux : corps désactivé par l'utilisateur (le hub l'ignore). */
  enabled?: boolean;
}

export type HubEvent =
  | { type: "join"; body: BodySessionInfo }
  | { type: "leave"; bodyId: string }
  | { type: "message"; bodyId: string; msg: BodyToKernel }
  | { type: "audio"; bodyId: string; frame: Float32Array };

/** Identité du corps, fixée par le transport (jamais par le client) : id sûr, nom, corps listé par un autre plugin. */
export interface AttachOpts {
  id?: string;
  name?: string;
  managed?: boolean;
}

/** Le hub des corps (fenêtre, page web, robot) : il les branche et leur envoie messages et son. */
export interface BodyHub {
  /** L'identité vient de `opts` (transport authentifié) ; le hello du client ne choisit ni id ni `managed`. */
  attach(transport: BodyTransport, opts?: AttachOpts): void;
  sessions(): BodySessionInfo[];
  has(bodyId: string, cap: Capability): boolean;
  send(bodyId: string, msg: KernelToBody): void;
  sendAudio(bodyId: string, data: Uint8Array): void;
  /** À tous les corps qui ont la capacité (ou à tous). */
  broadcast(msg: KernelToBody, cap?: Capability): void;
  on(fn: (ev: HubEvent) => void): () => void;
}

export interface AvatarInfo {
  id: string;
  name: Text;
  description: Text;
  emotions: string[];
}

export interface AvatarEntry extends AvatarInfo {
  /** Adresse file:// du module de dessin (renderer/index.js). */
  url: string;
  /** Aperçu fixe (renderer/preview.png) en adresse data:, s'il existe. Fabriqué par apps/desktop/scripts/avatar-previews.mjs. */
  preview?: string;
}

/** Les avatars de l'app de bureau : chaque plugin d'avatar s'y inscrit, la fenêtre des réglages les liste. */
export interface AvatarRegistry {
  /** Inscrit un avatar ; rend la fonction qui le retire. */
  register(a: AvatarEntry): () => void;
  list(): AvatarEntry[];
}

declare module "@floppy/core" {
  interface Services {
    body: BodyHub;
    avatars: AvatarRegistry;
  }
  interface HookTypes {
    /** Rendu à qui suit la programmation vocale ou l'affichage d'une initiative (le lance la conversation). */
    "initiative.presented": { input: InitiativePresented; output: void };
    /** Suivi de la file des initiatives (le lance la conversation). */
    "initiative.delivery": { input: InitiativeDelivery; output: void };
  }
}
