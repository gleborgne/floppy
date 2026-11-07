// Le contexte donné à apply(ctx, config). C'est la seule porte d'un plugin vers le noyau.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { CoreEvents } from "../bus.ts";
import type { Middleware } from "./hooks.ts";
import type { Disposer } from "./effects.ts";
import type { Services } from "../services.ts";
import type { ApprovalInput, ApprovalRequest, Decision } from "../approval.ts";
import type { Audit } from "../audit.ts";
import type { AssistantSettings } from "../config/schema.ts";
import type { ToolDef, ToolInfo, ToolResult, ToolCallMeta } from "../tools.ts";
import type { SettingDef, SettingInfo, ChangeResult } from "../settings.ts";
import type { ProviderDef, ItemStore, CatalogOp, CatalogVia, OpResult, ProviderSnapshot } from "../catalog.ts";
import type { Secrets } from "../secrets.ts";
import type { Text } from "../i18n.ts";
import type { Logo } from "../logo.ts";
import type { TaskInfo, TaskOutcome } from "../tasks.ts";
import type { ContextDownloads } from "../downloads.ts";
import type { MachineInfo } from "../machine.ts";

/** Tâches des plugins (voir tasks.ts) : pour un déclencheur (Planificateur) ou un plugin qui en lance une. */
export interface ContextTasks {
  list(): TaskInfo[];
  /** Lance une tâche et attend sa fin (un seul passage à la fois ; le résultat est annoncé par le noyau). */
  run(key: string, raison?: "horloge" | "manuel"): Promise<TaskOutcome>;
  /** La liste ou l'état d'une tâche a changé. */
  onChange(fn: () => void): void;
}

/** Réglages du plugin, modifiables à la voix ou par la CLI (voir settings.ts). */
export interface ContextSettings {
  declare(defs: SettingDef[]): void;
  /** Valeur gardée d'un démarrage précédent, à appliquer au démarrage. */
  saved<T>(key: string): T | undefined;
  /** Valeurs gardées dont la clé commence par `prefix` (non vide). */
  savedEntries(prefix: string): Record<string, unknown>;
  /** Valeur courante d'un réglage (sans calculer les choix ni les autres réglages). */
  value(key: string): unknown;
  /** Tous les réglages déclarés (tous plugins). */
  list(): SettingInfo[];
  /** Change un réglage comme une demande à la voix (risque contrôlé : accord si besoin, refus si « cli »). */
  change(key: string, value: unknown, origin?: string): Promise<ChangeResult>;
}

/**
 * Accords vus par un plugin. `check` : demander (tout plugin). `respond` / `pending` : répondre à la place de
 * l'utilisateur, seulement si le manifeste déclare `permissions.approvals: "respond"` (corps, conversation).
 */
export interface ContextApprovals {
  check(input: ApprovalInput): Promise<Decision>;
  respond(id: string, ok: boolean, by: string): boolean;
  pending(): ApprovalRequest[];
}

/** Accès au registre d'outils. Les outils ajoutés sont retirés au déchargement du plugin. */
export interface ContextTools {
  /** Retourne une fonction pour retirer ces outils plus tôt. */
  register(defs: ToolDef[]): () => void;
  list(): ToolInfo[];
  call(name: string, args: Record<string, unknown>, meta?: ToolCallMeta): Promise<ToolResult>;
  onChange(fn: () => void): void;
}

/** Origines qu'un plugin peut déclarer à ctx.items.run. */
export type PluginVia = Extract<CatalogVia, "voice" | "assistant">;

/** Éléments de la fenêtre des réglages (voir catalog.ts). Les fournisseurs sont retirés au déchargement. */
export interface ContextItems {
  declare(def: ProviderDef): void;
  /** Signale que la liste a changé (la fenêtre se met à jour). */
  changed(): void;
  /** Ajouts et modifications de l'utilisateur, gardés dans <home>/items/<nom>.json. */
  store(name?: string): ItemStore;
  /** Tous les fournisseurs et leurs éléments (pour l'assistant IA de la fenêtre des réglages). */
  snapshot(): Promise<ProviderSnapshot[]>;
  /**
   * Lance une opération du catalogue. `via: "assistant"` seulement après un accord explicite de l'utilisateur à l'écran
   * (ex. l'assistant IA montre la demande et l'utilisateur clique « Oui »). À la voix : `via: "voice"`.
   * « ui » et « cli » sont réservés à l'hôte (fenêtre, CLI) : un plugin ne peut pas les revendiquer.
   */
  run(op: CatalogOp, via: PluginVia): Promise<OpResult>;
  /** Boutons de l'élément « Application » de ce plugin (« Se connecter », « Se déconnecter »…). Clic seulement. */
  actions(list: { id: string; label: Text }[], run: (action: string) => Promise<OpResult>): void;
  /** État court du plugin, montré sur son élément « Application » (« surveillance active », « ne répond pas »). */
  status(text: Text, tone?: "ok" | "warn" | "error"): void;
  /**
   * Logo de son élément « Application », quand il dépend de la config (ex. le navigateur choisi).
   * undefined : celui du manifeste (addable.logo) ; null : aucun logo (l'initiale le remplace).
   */
  logo(logo: Logo | null | undefined): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Un élément qu'un plugin peut faire tourner à la demande (un modèle, une voix, une session Live). */
export interface OfferItem {
  id: string;
  label: Text;
  /** Mots qui le désignent à l'oral. */
  aliases?: string[];
  /** Les données partent dans le cloud : le choisir à la voix demande l'accord. */
  cloud?: boolean;
  /** Le démarrer prend du temps (charger un modèle) : la voie rapide le dit avant. */
  slow?: boolean;
}

/**
 * Offre d'un service par élément (fork, à la Cordis). Le noyau démarre `start(ctx, item)` quand un slot désigne
 * l'élément ET qu'un plugin actif s'en sert ; il ferme le fork (et tout ce qu'il a ouvert) quand plus personne ne s'en sert.
 */
export interface OfferDef<T = unknown> {
  /** Éléments actifs (les désactivés n'y sont pas). Lu à chaque fois. */
  items(): OfferItem[];
  /** Nombre de forks en même temps (ex. 1 : un seul modèle dans la mémoire du GPU). Le plus ancien est fermé d'abord. */
  max?: number;
  /**
   * Anciens ids d'éléments -> id actuel : un choix gardé (réglage, floppy.yml) qui désigne un ancien id suit l'élément
   * renommé au lieu de tomber dans le vide (ex. « claude » -> « sonnet » quand un plugin passe à un élément par modèle).
   */
  renamed?: Record<string, string>;
  /** Démarre l'élément : doit appeler ctx.provide(service, …). Ce qui est ouvert avec ctx (spawn, effect…) est fermé avec le fork. */
  start(ctx: Context, item: string): void | Promise<void>;
  /**
   * Délai pour `start` (défaut : 600 s). Au-delà, le fork passe en erreur et ce qu'il a ouvert est fermé.
   * Le temps passé à attendre d'autres plugins (ctx.use, ctx.slot) ne compte pas.
   */
  startTimeout_s?: number;
}

export interface ExecOptions {
  /** Délai (défaut : 30 000 ms). */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Taille maximale de la sortie (défaut : 16 Mo). */
  maxBuffer?: number;
  /** Arguments passés tels quels (Windows : commandes cmd avec guillemets). */
  verbatim?: boolean;
  /** Une sortie en erreur (code ≠ 0) ne rejette pas : le code est rendu. */
  allowFailure?: boolean;
  signal?: AbortSignal;
}

export interface ExecResult { stdout: string; stderr: string; code: number }

/** Un élément emprunté (ctx.borrow, ctx.borrowItem). */
export interface Borrowed<T> {
  service: T;
  /** Rend l'élément : le noyau l'arrête si plus personne ne s'en sert. */
  release(): void;
  /** Tenue si l'élément s'arrête ou tombe en panne pendant l'emprunt : le service n'est plus utilisable, il faut le réemprunter. */
  lost: Promise<void>;
}

export interface Context {
  /** Id de l'entrée dans la config (ex. "brain"). */
  readonly id: string;
  /** Nom du plugin (ex. "brain-aisdk"). */
  readonly plugin: string;
  /** Réglages globaux : nom de l'assistant, langue, mots d'activation. */
  readonly assistant: AssistantSettings;
  /** Langue de l'interface (ce que l'utilisateur lit dans les fenêtres) : « fr » ou « en ». La langue de ce que Floppy dit est assistant.language. */
  uiLang(): string;
  /** Ce que Floppy lit de la machine : puce graphique, type de mémoire, mémoire pour les modèles, moteurs (cuda, metal…). */
  machine(): Promise<MachineInfo>;
  /**
   * Relance les éléments offerts (ctx.offer) qui tournent ou sont en panne : ils repartent avec le nouveau programme ou
   * les nouveaux réglages. `service` : seulement ceux de ce service. Depuis un fork : ceux de son plugin.
   */
  restartOffers(service?: string): Promise<void>;
  readonly approvals: ContextApprovals;
  readonly audit: Audit;
  /**
   * Espace de travail du plugin dans le répertoire de travail : <home>/workspaces/<id du plugin>/<nom> (créé).
   * Pour les agents lancés (Claude, Codex…), les fichiers temporaires d'un travail, les sessions.
   */
  workspace(name?: string): string;
  /** Répertoire de travail de Floppy (%LOCALAPPDATA%\floppy par défaut, choisi dans les réglages, ou FLOPPY_HOME). */
  readonly home: string;
  readonly tools: ContextTools;
  readonly settings: ContextSettings;
  readonly items: ContextItems;
  /** Coffre des secrets (Gestionnaire d'identification Windows). Cloisonné : seuls les noms « <plugin>/… » (id du manifeste) sont permis. */
  readonly secrets: Secrets;
  readonly tasks: ContextTasks;
  /** Téléchargements de fichiers (modèles, voix) dans un dossier propre à l'entrée. Sites permis : permissions.net. */
  readonly downloads: ContextDownloads;

  /** Fork : l'élément que ce contexte fait tourner (voir offer). Absent pour une entrée normale. */
  readonly item?: string;

  provide<K extends keyof Services & string>(name: K, impl: Services[K]): void;
  /**
   * Pendant apply : demande un service, et le démarre s'il est en veille (plugin `lazy`). Le plugin redémarre si ce
   * fournisseur change ou s'arrête. undefined : aucun fournisseur. Ne pas l'appeler = ne pas en avoir besoin.
   */
  use<K extends keyof Services & string>(name: K): Promise<Services[K] | undefined>;
  /**
   * Pendant apply : service de l'élément choisi pour un slot du manifeste (démarré à la demande). Le plugin redémarre
   * quand le choix change. undefined : « aucun » choisi, ou élément indisponible (désactivé, en panne).
   */
  slot<T = unknown>(id: string): Promise<T | undefined>;
  /**
   * Après apply : emprunte l'élément choisi pour un slot du manifeste le temps d'un travail (ex. trier des articles),
   * sans le garder en marche. Le noyau le démarre si besoin ; release() le rend (il s'arrête si plus personne ne s'en sert).
   * Rendu automatiquement quand le plugin s'arrête. undefined : « aucun » choisi, ou élément indisponible.
   */
  borrow<T = unknown>(id: string): Promise<Borrowed<T> | undefined>;
  /**
   * Tous les éléments offerts pour un service (déclaré dans inject/optional), tous plugins : ex. les canaux « notify ».
   * value = "<entrée>/<élément>" (à passer à borrowItem).
   */
  offers(service: string): { value: string; label: Text; cloud?: boolean; entry: string }[];
  /** Comme borrow, mais pour un élément précis (value de offers) au lieu du choix d'un slot. */
  borrowItem<T = unknown>(service: string, value: string): Promise<Borrowed<T> | undefined>;
  /** Offre `service` élément par élément (voir OfferDef). Le service doit être dans `provides`. */
  offer<K extends keyof Services & string>(service: K, def: OfferDef<Services[K]>): void;
  /** Service déclaré dans inject (toujours là) ou optional (peut être undefined). */
  get<K extends keyof Services & string>(name: K): Services[K];
  maybe<K extends keyof Services & string>(name: K): Services[K] | undefined;
  /** Fournisseur explicitement choisi, même s'il est indisponible ; undefined = aucun choix explicite. */
  selectedProvider<K extends keyof Services & string>(name: K): string | undefined;

  effect(dispose: Disposer): () => Promise<void>;
  on<K extends keyof CoreEvents & string>(event: K, fn: (payload: CoreEvents[K]) => void): void;
  /** Émet sur le bus. Les événements du noyau (accords, état des plugins, services, tâches, relance) sont refusés. */
  emit<K extends keyof CoreEvents & string>(event: K, payload: CoreEvents[K]): void;
  /**
   * fetch avec un délai par défaut (30 s, `timeoutMs` le change) et l'hôte vérifié contre permissions.net : un hôte
   * absent est signalé au journal (avertissement, pas encore refusé). Refusé après l'arrêt du plugin.
   */
  fetch(url: string | URL, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  hook<I, O>(name: string, mw: Middleware<I, O>): void;
  /** Lance la chaîne d'un hook (ex. tools lance `tool.before`). */
  runHook<I, O>(name: string, input: I, final: (input: I) => Promise<O>): Promise<O>;

  /**
   * Lance un processus enfant (programme permis par permissions.exec) ; il est tué (avec ses enfants) au déchargement.
   * `keep: true` : un programme lancé pour l'utilisateur (navigateur, terminal) qui doit rester ouvert, détaché.
   */
  spawn(command: string, args: string[], options?: SpawnOptions & { keep?: boolean }): ChildProcess;
  /**
   * Lance une commande courte et rend sa sortie (programme permis par permissions.exec). Toujours un délai
   * (défaut : 30 s) ; arrêtée au déchargement. Rejette si le programme manque, dépasse le délai ou sort en erreur
   * (le code et la sortie d'erreur sont dans le message).
   */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  interval(fn: () => void, ms: number): void;
  timeout(fn: () => void, ms: number): void;

  /** Signale une panne grave après le démarrage : le plugin est arrêté et passe en erreur visible (texte simple ou { fr, en }). */
  fail(reason: Text): void;
  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void;
  /** Vrai tant que le plugin n'est pas déchargé. */
  readonly alive: boolean;
}
