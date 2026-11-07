// Corps (fenêtre, robot, page web) branchés au hub, et avatars de l'app de bureau.
import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import type { Text } from "@floppy/core";

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
}
