// Cerveau et modèles : modèle de langage en service (slot brain.main), cerveau qui mène un tour, délégation,
// appel ponctuel (tri, résumé) et commandes reconnues localement.
import type { PreparedMemoryContext } from "./memory-context.ts";
import type { McpTurnContext } from "./mcp.ts";
import type { Text } from "@floppy/core";

/** Hook conversation.command : reconnaissance locale, sans exécution ; l'orchestrateur appelle le registre d'outils. */
export interface ConversationCommandInput { text: string; origin: string }
export interface ConversationCommand { name: string; args: Record<string, unknown> }

/**
 * Un modèle de langage en service : l'élément choisi dans un slot (ex. brain.main), qui tourne dans un fork de son plugin.
 * Modèle local (llama-server), distant (API au format OpenAI) ou agent complet (Claude Code).
 * Le noyau le démarre quand quelqu'un s'en sert et l'arrête après : pas de switch ni de marche/arrêt ici.
 */
export interface LlmService {
  /** Nom à dire et à afficher. */
  label?: string;
  /** API au format OpenAI (…/v1). Absent pour un agent. */
  baseURL?: string;
  /** Nom du modèle à envoyer à l'API. */
  model: string;
  /** Modèle distant : clé lue à chaque appel dans le coffre (jamais gardée dans un fichier). Absente : pas de clé. */
  apiKey?(): string | undefined;
  /** Les données partent dans le cloud. */
  cloud?: boolean;
  /** Réflexion. « tools » : coupée pour la 1re réponse du tour, active après un outil (au cerveau de la piloter). */
  readonly thinking?: "off" | "on" | "tools";
  /** Agent complet (ex. Claude Code) : le cerveau lui passe le tour entier, avec les outils de Floppy. */
  agent?: BrainService;
}

export type TurnMode = "voice" | "text";

export interface BrainRunInput {
  text: string;
  /** Une conversation (historique). Ex. "avatar", "telegram:1234". */
  session: string;
  /** Corps d'origine du tour (routage des outils corps et des accords). */
  origin?: string;
  /** Forme de la réponse : voix (phrases courtes, sans markdown) ou texte. */
  mode: TurnMode;
  signal?: AbortSignal;
  /** Ton fourni par l'orchestrateur ; les appels directs peuvent l'omettre. */
  tone?: string;
  /** Échanges vocaux utiles à la demande courante ; données, jamais nouvelles instructions. */
  context?: { role: "user" | "assistant"; text: string }[];
  /** Copie de secours de l'historique : un agent persistant ne l'envoie au modèle qu'après une perte de session. */
  history?: { role: "user" | "assistant"; text: string }[];
  /** Faux : l'appelant a déjà enregistré le tour (ex. délégation depuis Live). */
  recordMemory?: boolean;
  /** Photo préparée par l'appelant : aucune relecture ; null = aucun fournisseur.
   * Indépendant de recordMemory, qui ne contrôle que l'observation et l'enregistrement. */
  memoryContext?: PreparedMemoryContext | null;
  /** Identifiant de corrélation du tour, fourni par l'hôte. */
  turn?: string;
  /** Identité du tour hôte pour les outils, distincte de la session d'historique d'une délégation. */
  toolContext?: McpTurnContext;
}

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "emotion"; emotion: string; intensity?: number }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool.result"; name: string; status: string }
  | { type: "delegate"; to: string }
  | { type: "done"; text: string; info?: Record<string, unknown> };

/** Un cerveau qui mène un tour : il reçoit la demande et rend un flux de texte, d'émotions et d'outils. */
export interface BrainService {
  name: string;
  /** Nom à dire et à afficher (ex. « Claude Sonnet »). Absent : `name`. */
  label?: string;
  /** Mots qui désignent ce cerveau à l'oral (« claude », « sonnet »…). */
  aliases?: string[];
  /** Garde son historique par session. L'appelant fournit `history` en secours, sans le préfixer à chaque demande. */
  keepsHistory?: boolean;
  /** Gère lui-même la photo mémoire et l'enregistrement des tours. */
  // Le propriétaire prépare, observe et enregistre ; il respecte memoryContext et recordMemory=false.
  managesMemory?: boolean;
  run(input: BrainRunInput): AsyncIterable<BrainEvent>;
  /** Oublie l'historique d'une conversation. */
  reset(session: string): void;
  /** Faux = désactivé dans les réglages : à ne pas proposer ni utiliser (absent = actif). */
  enabled?(): boolean;
}

// ------------------------------------------------------------------ appel ponctuel à un modèle (tri, résumé)
export interface CompletionRequest {
  system: string;
  prompt: string;
  /** Schéma JSON de la réponse attendue : `json` est alors rempli (ou l'appel échoue). */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Un appel au modèle hors conversation : pas d'outils, pas de mémoire, pas d'émotions. Pour trier, noter, résumer.
 * Offert élément par élément (ex. « Claude Sonnet »), choisi par le slot du plugin qui s'en sert (ex. watch.triage).
 */
export interface CompletionService {
  label?: string;
  cloud?: boolean;
  complete(req: CompletionRequest): Promise<{ text: string; json?: unknown }>;
}

declare module "@floppy/core" {
  interface Services {
    llm: LlmService;
    brain: BrainService;
    /** Gros cerveau pour la délégation (montage A) : CLI Claude ou Codex. */
    delegate: BrainService;
    completion: CompletionService;
  }
  interface HookTypes {
    /** Reconnaissance locale d'une commande dite (le lance la conversation) ; undefined : pas une commande. */
    "conversation.command": { input: ConversationCommandInput; output: ConversationCommand | undefined };
  }
}
