// Assistant IA de la fenêtre des réglages (plugin coder) : agents en ligne de commande pilotés pour l'utilisateur.
import type { Text } from "@floppy/core";

/** Id d'un agent fourni par le plugin (ex. "claude", "codex") : jamais une clé API, le CLI officiel de l'utilisateur. */
export type CoderAgent = string;

export interface CoderAgentInfo {
  id: CoderAgent;
  label: Text;
  /** CLI trouvé dans le PATH. La connexion est vérifiée au premier message. */
  available: boolean;
  /** Commande à lancer pour se connecter (« claude /login »). */
  loginHint?: Text;
}
/** reglages : seulement les outils de réglages. plugin : écrire un plugin dans <home>/plugins (avec validation). */
export type CoderMode = "reglages" | "plugin";

export type CoderEvent =
  | { type: "status"; sessionId: string; status: "starting" | "ready" | "busy" }
  | { type: "text"; sessionId: string; delta: string }
  | { type: "tool"; sessionId: string; id: string; name: string; input?: unknown; status: "running" | "done" | "failed"; output?: string }
  /** Une action attend la validation de l'utilisateur (écrire un fichier…). `diff` : aperçu avant / après. */
  | { type: "permission"; sessionId: string; id: string; tool: string; description: string; input?: unknown; diff?: { path: string; before?: string; after?: string } }
  | { type: "done"; sessionId: string; stopReason: "end" | "cancelled" | "error"; error?: string; signIn?: boolean };

export interface CoderService {
  /** Agents connus du plugin, avec leur disponibilité. */
  agents(): Promise<CoderAgentInfo[]>;
  /** Ouvre une conversation ; rend son id. */
  start(opts: { agent: CoderAgent; mode: CoderMode }): Promise<string>;
  send(sessionId: string, text: string): void;
  /** Bouton stop : arrête le tour en cours. */
  cancel(sessionId: string): void;
  answerPermission(sessionId: string, permissionId: string, allow: boolean): void;
  close(sessionId: string): void;
  onEvent(fn: (e: CoderEvent) => void): () => void;
  /** Agents qui savent relire un plugin tiers (CLI trouvé). */
  reviewers?(): Promise<CoderAgentInfo[]>;
  /**
   * Relit un plugin tiers : un tour unique, SANS outil (le code est dans `prompt`), dans un dossier vide.
   * `agent` absent : le premier disponible. Rend la réponse brute de l'agent.
   */
  review?(input: { prompt: string; agent?: CoderAgent; signal?: AbortSignal }): Promise<{ agent: CoderAgent; text: string }>;
}

declare module "@floppy/core" {
  interface Services {
    coder: CoderService;
  }
}
