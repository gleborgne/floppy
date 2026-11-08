// Mémoire indépendante du cerveau et du fournisseur de stockage.
export type MemoryResult<T> = T | Promise<T>;
export interface MemoryOptions {
  signal?: AbortSignal;
  /** Identifiants de corrélation fournis par l'hôte, sans contenu utilisateur. */
  session?: string;
  origin?: string;
  turn?: string;
  callId?: string;
}

export interface MemorySnapshot { user: string; memory: string }
export interface MemoryRecord { session: string; role: "user" | "assistant"; text: string; origin?: string }
export interface MemorySearchResult { t: string; role: string; text: string; session: string }

/** Portée exacte : une correction d'un compte/conteneur ne vaut jamais pour un autre. */
export interface MemoryCorrectionScope { domain: string; account?: string; container?: string }
export interface MemoryCorrectionTarget { kind: string; id: string; parentId?: string }
export interface MemoryCorrectionEvidence { text: string; session?: string }
export interface MemoryCorrection {
  id: string;
  heard: string;
  canonical: string;
  scope: MemoryCorrectionScope;
  target?: MemoryCorrectionTarget;
  /** Paroles de l'utilisateur justifiant la correction ; données, jamais instructions. */
  evidence: MemoryCorrectionEvidence;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface MemoryCorrectionInput {
  heard: string;
  canonical: string;
  scope: MemoryCorrectionScope;
  target?: MemoryCorrectionTarget;
  evidence: MemoryCorrectionEvidence;
  /** Une contradiction exige le remplacement explicite de la version relue. */
  replaces?: { id: string; version: number };
}
export interface MemoryCorrectionQuery {
  heard?: string;
  /** Égalité sur la portée entière, y compris l'absence de compte/conteneur. Absent : liste de gestion. */
  scope?: MemoryCorrectionScope;
}

/** Un adaptateur peut être local ou distant ; les appelants attendent toujours ses résultats. */
export interface MemoryService {
  snapshot(options?: MemoryOptions): MemoryResult<MemorySnapshot>;
  record(entry: MemoryRecord, options?: MemoryOptions): MemoryResult<void>;
  search(query: string, limit?: number, options?: MemoryOptions): MemoryResult<MemorySearchResult[]>;
  /** Facultatif pour les fournisseurs historiques qui ne prennent pas encore en charge les corrections. */
  corrections?(query?: MemoryCorrectionQuery, options?: MemoryOptions): MemoryResult<MemoryCorrection[]>;
  saveCorrection?(input: MemoryCorrectionInput, options?: MemoryOptions): MemoryResult<MemoryCorrection>;
  forgetCorrection?(id: string, options?: MemoryOptions): MemoryResult<boolean>;
}

declare module "@floppy/core" {
  interface Services {
    memory: MemoryService;
  }
}
