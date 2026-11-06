// Types d'un plugin utilisateur Floppy. Ce fichier ne contient que des types : ne l'importe qu'avec `import type`.
// Usage dans <id>/index.ts :  import type { UserPlugin } from "../floppy-plugin.d.ts";

/** Niveau d'un outil. Il décide de l'accord demandé à l'utilisateur. */
export type ToolLevel = "read" | "write" | "send" | "delete";
/** Risque d'un réglage : free = tout de suite ; ask = demande l'accord ; cli = jamais à la voix. */
export type SettingRisk = "free" | "ask" | "cli";

export interface Permissions {
  /** Dossiers lus (chemins ou motifs). */
  "fs.read"?: string[];
  /** Dossiers écrits. */
  "fs.write"?: string[];
  /** Hôtes réseau joignables (ex. "api.exemple.fr"). Sans cela : aucun accès réseau. */
  net?: string[];
  /** Programmes lancés. */
  exec?: string[];
  cloud?: boolean;
}

export interface Manifest {
  /** Identique au nom du dossier : ^[a-z][a-z0-9-]*$ */
  id: string;
  version: string;
  description?: string;
  /** Licence du plugin (ex. "MIT"). */
  licence: string;
  /** Services fournis. Souvent vide pour un plugin d'outils. */
  provides?: string[];
  /** Services obligatoires : sans eux, le plugin attend. */
  inject?: string[];
  /** Services facultatifs. */
  optional?: string[];
  permissions?: Permissions;
  /** Rubriques que ce plugin ajoute à la fenêtre des réglages (id, label, order…). Facultatif. */
  sections?: { id: string; label: string | { fr: string; en?: string }; description?: string | { fr: string; en?: string }; order?: number; parent?: string }[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolCallMeta {
  caller?: string;
  origin?: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** done = fait ; unverified = fait mais non vérifié ; failed = raté ; refused = refusé. */
  status: "done" | "unverified" | "failed" | "refused";
  /** Texte rendu au modèle (en français, court). */
  text: string;
  raw?: unknown;
}

/** Un outil que l'assistant peut appeler. */
export interface ToolDef {
  /** snake_case, en français ou anglais simple (ex. "lancer_minuteur"). */
  name: string;
  /** Dit au modèle quand l'utiliser. */
  description: string;
  /** JSON Schema des paramètres (type: "object"). */
  inputSchema: JsonSchema;
  level: ToolLevel;
  /** Phrase pour la demande d'accord. */
  summary?: (args: Record<string, unknown>) => string;
  handler: (args: Record<string, unknown>, meta: ToolCallMeta) => Promise<ToolResult>;
}

export interface SettingOption {
  value: string;
  label: string;
  /** Mots qui désignent cette valeur à l'oral. */
  aliases?: string[];
}

/** Un réglage, visible dans la fenêtre des réglages et modifiable à la voix. */
export interface SettingDef {
  /** [a-z0-9_] ; préfixe-le par l'id du plugin pour éviter les conflits. */
  key: string;
  label: string;
  description: string;
  type: "enum" | "number" | "boolean" | "text";
  /**
   * Rubrique de la fenêtre des réglages (obligatoire) : "general" pour un réglage ordinaire, ou l'id d'une rubrique
   * déclarée par un plugin (cerveau, voix, ecoute, connecteurs, corps…) ou par ton manifeste (`sections`).
   */
  section: string;
  group?: string;
  options?: SettingOption[];
  min?: number;
  max?: number;
  maxLength?: number;
  risk: SettingRisk;
  riskFor?: (value: unknown) => SettingRisk;
  get(): unknown;
  /** Applique la valeur tout de suite. */
  set(value: unknown): void | Promise<void>;
}

/** Événements du bus que tu peux écouter (ctx.on) ou émettre (ctx.emit). */
export interface BusEvents {
  /** Quelque chose à dire à l'utilisateur de soi-même (rappel, fin de tâche). `key` évite les doublons. */
  initiative: { source: string; text: string; importance: "important" | "normal"; key?: string };
  /** Changement d'état d'un plugin. */
  "plugin.state": { id: string; plugin: string; state: string; error?: string };
  /** Un service a un nouveau fournisseur. */
  "service.changed": { name: string; provider?: string };
}

/** Ce que ton plugin peut utiliser. Tout est retiré à la fin du plugin (effects). */
export interface PluginContext {
  /** Nom de ton entrée dans la config. */
  readonly id: string;
  readonly plugin: string;
  readonly assistant: { readonly name: string };
  /** Journal : écris-y ce qui compte (jamais de secret). */
  readonly audit: { write(rec: { kind: string; [key: string]: unknown }): void };
  readonly tools: {
    /** Ajoute des outils ; retourne une fonction pour les retirer plus tôt. */
    register(defs: ToolDef[]): () => void;
  };
  readonly settings: {
    declare(defs: SettingDef[]): void;
    /** Valeur gardée d'un démarrage précédent. */
    saved<T>(key: string): T | undefined;
  };
  on<K extends keyof BusEvents & string>(event: K, fn: (payload: BusEvents[K]) => void): void;
  emit<K extends keyof BusEvents & string>(event: K, payload: BusEvents[K]): void;
  /** Enregistre un nettoyage, appelé quand le plugin s'arrête ou se recharge. */
  effect(dispose: () => void | Promise<void>): () => Promise<void>;
  interval(fn: () => void, ms: number): void;
  timeout(fn: () => void, ms: number): void;
  log(level: "debug" | "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void;
  /** Vrai tant que le plugin n'est pas arrêté. */
  readonly alive: boolean;
  /** Signale une panne grave : le plugin s'arrête et l'erreur est visible. */
  fail(reason: string): void;
}

/** Ce que `export default` d'un plugin utilisateur doit être : un simple objet. */
export interface UserPlugin<C = Record<string, never>> {
  manifest: Manifest;
  /** Facultatif : valide la config de l'entrée. Rends la config propre, ou lève une erreur. */
  config?: { parse(input: unknown): C };
  apply(ctx: PluginContext, config: C): void | Promise<void>;
}
