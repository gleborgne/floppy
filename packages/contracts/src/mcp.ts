// Serveur MCP de Floppy (fourni par le plugin tools) : les agents lancés voient les outils de Floppy par lui.

/** Outil en mémoire, ajouté à un accès restreint (hors registre : pas d'accord ni de journal du noyau). */
export interface ExtraTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

export interface ScopedOptions {
  /** Outils du registre visibles (noms exacts). Un nom absent du registre est ignoré. */
  tools: string[];
  extraTools?: ExtraTool[];
}

/** Contexte de tour attaché par Floppy, jamais accepté depuis une requête MCP du modèle. */
export interface McpTurnContext {
  session: string;
  origin?: string;
  turn?: string;
  signal?: AbortSignal;
}

export interface ScopedEndpoint {
  url: string;
  /** Jeton propre à cet accès : il ne liste et n'appelle que les outils demandés. */
  token: string;
  /** Lie le jeton au tour actif. La fermeture annule les appels encore en cours de ce tour. */
  bindContext?(context: McpTurnContext): () => void;
  /** Révoque le jeton. */
  close(): void;
}

/** Le serveur MCP de Floppy : les agents lancés y voient les outils de Floppy (tous, ou quelques-uns par un accès restreint). */
export interface McpEndpoint {
  /** http://127.0.0.1:<port>/mcp */
  url: string;
  /** Jeton à envoyer en `Authorization: Bearer <jeton>`. Nouveau à chaque démarrage. Voit tous les outils. */
  token: string;
  /** Plusieurs tours distincts sur le même jeton rendent le contexte ambigu (aucune session attribuée). */
  bindContext?(context: McpTurnContext): () => void;
  /** Accès restreint à quelques outils (assistant de la fenêtre des réglages). */
  scoped(opts: ScopedOptions): ScopedEndpoint;
  /** Tenue quand les connecteurs du démarrage ont fini de se brancher (réussis ou non). Ils se branchent après `apply`. */
  connected?(): Promise<void>;
}

declare module "@floppy/core" {
  interface Services {
    mcp: McpEndpoint;
  }
}
