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

export interface ScopedEndpoint {
  url: string;
  /** Jeton propre à cet accès : il ne liste et n'appelle que les outils demandés. */
  token: string;
  /** Révoque le jeton. */
  close(): void;
}

export interface McpEndpoint {
  /** http://127.0.0.1:<port>/mcp */
  url: string;
  /** Jeton à envoyer en `Authorization: Bearer <jeton>`. Nouveau à chaque démarrage. Voit tous les outils. */
  token: string;
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
