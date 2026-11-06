import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import type { Text } from "./i18n.ts";

/** Fournisseur prêt ou non. `reason` : en clair, dans la langue de l'assistant ; `reasonText` : en français et en anglais. */
export interface Availability {
  ready: boolean;
  reason?: string;
  reasonText?: Text;
}

/** Hook conversation.command : reconnaissance locale, sans exécution ; l'orchestrateur appelle le registre d'outils. */
export interface ConversationCommandInput { text: string; origin: string }
export interface ConversationCommand { name: string; args: Record<string, unknown> }

// Registre des types de services. Chaque service a un contrat ici ; les plugins le fournissent ou l'utilisent.
// Un plugin peut ajouter un service par fusion de déclaration :
//   declare module "@floppy/core" { interface Services { monService: MonType } }

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
}

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "emotion"; emotion: string; intensity?: number }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool.result"; name: string; status: string }
  | { type: "delegate"; to: string }
  | { type: "done"; text: string; info?: Record<string, unknown> };

export interface BrainService {
  name: string;
  /** Nom à dire et à afficher (ex. « Claude Sonnet »). Absent : `name`. */
  label?: string;
  /** Mots qui désignent ce cerveau à l'oral (« claude », « sonnet »…). */
  aliases?: string[];
  run(input: BrainRunInput): AsyncIterable<BrainEvent>;
  /** Oublie l'historique d'une conversation. */
  reset(session: string): void;
  /** Faux = désactivé dans les réglages : à ne pas proposer ni utiliser (absent = actif). */
  enabled?(): boolean;
}

export interface MemorySnapshot {
  user: string;
  memory: string;
}

export interface MemoryService {
  /** USER.md et MEMORY.md, lus maintenant. Le cerveau en garde une photo par conversation. */
  snapshot(): MemorySnapshot;
  /** Ajoute un message à l'historique (SQLite FTS5). */
  record(e: { session: string; role: "user" | "assistant"; text: string; origin?: string }): void;
  search(query: string, limit?: number): { t: string; role: string; text: string; session: string }[];
}

/** Événements d'un flux voix (un corps qui a un micro). */
export type VoiceEvent =
  | { type: "vad"; state: "speech" | "silence" }
  | { type: "merge" }
  | { type: "transcript"; text: string; audio_s: number; stt_ms: number; merged: boolean; utt?: number; /** Silence attendu par le VAD avant la fin (0 en push-to-talk). */ silence_ms?: number; start_sample?: number; end_sample?: number }
  | { type: "barge_in" }
  /** Dictée : hypothèse pour un segment (coupé aux pauses). final : version définitive du segment. */
  | { type: "dictation"; seg: number; text: string; final: boolean }
  | { type: "audio"; id: string; data: Uint8Array }
  | { type: "audio_start"; id: string }
  | { type: "speak_done"; id: string; cancelled: boolean; first_audio_ms?: number; error?: string }
  | { type: "closed" };

export interface VoiceStream {
  /** Audio micro : float32 mono 16 kHz. */
  pushAudio(frame: Float32Array): void;
  /**
   * Dire une phrase (file d'attente). L'audio revient par l'événement `audio` (4 octets taux + PCM int16).
   * Absent : ce flux ne parle pas (écoute seule) ; la voix passe par le service `tts`.
   */
  speak?(id: string, text: string): void;
  /** Vider la file et couper la phrase en cours. */
  cancel(): void;
  /** La voix joue chez le corps : arme l'interruption. */
  setSpeaking(on: boolean): void;
  ptt(on: boolean): void;
  /** Dictée : le texte n'est pas une demande ; il revient en événements `dictation`, sans `transcript`. */
  dictate?(on: boolean): void;
  /** En Live, chaque activation correspond à un seul énoncé local (pas de fusion avec une phrase ignorée). */
  setMergeEnabled?(on: boolean): void;
  on(fn: (ev: VoiceEvent) => void): () => void;
  close(): void;
}

export interface VoiceService {
  name: string;
  /** Ouvre un flux pour un corps (un id par corps). La voix locale y parle quand un fork « tts » local est en service. */
  open(streamId: string): Promise<VoiceStream>;
}

export interface TtsChunk { rate: number; pcm: Int16Array }

/** Début ou fin de parole ; sample = index de l'échantillon dans le flux du détecteur (compté depuis open ou reset). */
export interface VadEvent { type: "start" | "end"; sample: number }
export interface VadStream {
  /** Son float32 mono 16 kHz, blocs de toute taille, dans l'ordre. Rend les débuts et fins détectés dans ce bloc. */
  push(frame: Float32Array): VadEvent[];
  /** Oublie l'état (nouvelle écoute) ; le compteur d'échantillons repart de 0. */
  reset(): void;
  close(): void;
}
/** Détecteur de parole en service (l'élément choisi dans le slot listen.vad). Un flux par corps : il a un état. */
export interface VadService {
  name: string;
  /** Silence attendu avant la fin d'une phrase (compté dans la latence perçue). */
  minSilenceMs: number;
  open(): VadStream;
}
/** Transcription en service (l'élément choisi dans le slot listen.stt). Partagée entre les corps. */
export interface SttService {
  name: string;
  /** Langues connues du modèle (« fr », « en »…). Absent : inconnu. */
  languages?: string[];
  /** Un morceau de son float32 mono 16 kHz -> texte. */
  transcribe(audio: Float32Array, opts?: { language?: string; signal?: AbortSignal }): Promise<{ text: string }>;
}


/** Détection locale, indépendante du cerveau et des fournisseurs Live ; audio ou transcriptions existantes. */
export interface WakewordDetection {
  word: string;
  /** Fenêtre audio à rejouer, indices absolus sur le micro mono 16 kHz. Sans indices STT, seule la cascade est autorisée. */
  startSample?: number;
  endSample?: number;
}
export interface WakewordTranscript { text: string; startSample?: number; endSample?: number }
export interface WakewordStream {
  /** Blocs ordonnés ; startSample appartient à l'horloge du corps, pas à celle du moteur. */
  pushAudio(frame: Float32Array, startSample: number): void;
  /** Réutilise la transcription existante ; aucun deuxième flux ni modèle STT. */
  pushTranscript?(transcript: WakewordTranscript): void;
  close(): void;
}
export interface WakewordService {
  name: string;
  /** Audio par défaut. Une source transcription attend la phrase avant d'ouvrir Live. */
  input?: "audio" | "transcript";
  words?(): string[];
  availability(): Availability;
  /** Une configuration sauvegardée invalide les détecteurs ouverts. */
  onChange(fn: () => void): () => void;
  open(opts: { body: string; signal: AbortSignal; onDetection(event: WakewordDetection): void; onError(message: string): void }): Promise<WakewordStream>;
}
/** Une voix en service (l'élément choisi dans le slot voice.tts) : moteur ET voix. */
export interface TtsService {
  name: string;
  availability?(): Availability;
  /** Voix locale : elle parle dans le flux du service `voice` (VoiceStream.speak), pas par speak(). */
  viaStream?: boolean;
  speak?(text: string, opts: { signal: AbortSignal }): AsyncIterable<TtsChunk>;
}

/** Les blocs sont ordonnés. final et generation_done sont facultatifs dans le protocole
 * fournisseur (GPT Live ne les émet pas) : l'orchestrateur utilise aussi la fin de lecture
 * et des fenêtres de silence bornées. generation désigne une époque de lecture locale. */
export type LiveEvent =
  | { type: "audio"; generation: number; rate: number; pcm: Int16Array }
  | { type: "input_transcript"; text: string; final: boolean; startMs?: number; endMs?: number }
  | { type: "output_transcript"; text: string; final: boolean }
  | { type: "interrupted"; generation: number }
  | { type: "generation_done" }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_cancelled"; ids: string[] }
  | { type: "delegation"; id: string; offsetMs: number }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "closed"; reason: string };

export interface LiveSession {
  pushAudio(frame: Float32Array): void;
  /** Présent uniquement pour les sessions à appels de fonctions. */
  toolResult?(id: string, name: string, result: { text: string; status: string }): void;
  append(kind: "say" | "think" | "instruct", text: string, delegationId?: string): void;
  close(): Promise<void>;
}
export interface LiveService {
  name: string;
  availability?(): Availability;
  capabilities: { tools: "function" | "delegation" };
  open(opts: { body: string; instructions: string; tools: import("./tools.ts").ToolInfo[]; signal: AbortSignal; on: (event: LiveEvent) => void }): Promise<LiveSession>;
}

// ------------------------------------------------------------------ assistant IA de la fenêtre des réglages
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

// ------------------------------------------------------------------ service mcp (fourni par le plugin tools)
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
}

// ------------------------------------------------------------------ service body (fourni par body-hub)
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

declare module "@floppy/core" {
  interface Services {
    body: BodyHub;
  }
}

// ------------------------------------------------------------------ service avatars (fourni par body-electron)
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

// ------------------------------------------------------------------ recherche (websearch, searxng…)
/** Un résultat de recherche. */
export interface SearchHit {
  titre: string;
  url: string;
  resume?: string;
  /** Site ou flux d'origine (ex. « lemonde.fr »). */
  source?: string;
  /** Date de publication, si connue (ISO 8601). */
  date?: string;
}

/**
 * Recherche web en service, pour les autres plugins (la Veille). Le même plugin donne en général aussi un outil
 * au cerveau : un seul code, deux usages. Offert élément par élément (ctx.offer) pour être choisi dans un slot.
 */
export interface SearchService {
  label?: string;
  /** Les requêtes partent dans le cloud. */
  cloud?: boolean;
  search(q: string, opts?: { max?: number; /** Seulement après cette date (au mieux). */ depuis?: Date; signal?: AbortSignal }): Promise<SearchHit[]>;
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
 * Offert élément par élément (ex. « Claude Sonnet »), choisi par le slot du plugin qui s'en sert (ex. veille.tri).
 */
export interface CompletionService {
  label?: string;
  cloud?: boolean;
  complete(req: CompletionRequest): Promise<{ text: string; json?: unknown }>;
}

// ------------------------------------------------------------------ documents Markdown (« artefacts »)
export interface DocRef {
  id: string;
  titre: string;
  /** ISO 8601. */
  date: string;
  source: string;
  tags: string[];
}

export interface DocumentsService {
  /** Enregistre un document Markdown (fichier dans <home>/documents). */
  save(doc: { titre: string; markdown: string; source: string; tags?: string[] }): Promise<DocRef>;
  /**
   * Montre un document. `cible` : un corps précis, sinon le corps d'origine s'il sait afficher, sinon le premier corps
   * qui sait afficher. Un corps texte reçoit le Markdown ; un corps voix seule, rien (l'appelant dit un résumé).
   * Rend l'id du corps qui l'affiche, ou undefined.
   */
  show(id: string, cible?: string): Promise<string | undefined>;
  list(filtre?: { tag?: string; max?: number }): Promise<DocRef[]>;
  get(id: string): Promise<(DocRef & { markdown: string }) | undefined>;
  /** Supprime un document (son fichier). Faux : il n'existait pas. */
  remove?(id: string): Promise<boolean>;
}

// ------------------------------------------------------------------ tâches (veille, résumés…)
/** Pourquoi une tâche tourne. */
export type TaskReason = "horloge" | "voix" | "manuel";

export interface TaskRunInput {
  signal: AbortSignal;
  raison: TaskReason;
  /** Fin du dernier passage réussi (absent : jamais). */
  dernierPassage?: Date;
}

export interface TaskResult {
  /** Une ou deux phrases, dites ou montrées à l'utilisateur (« Ta veille est prête : 14 articles. »). */
  resume: string;
  /** Document produit : le noyau le montre (service documents). */
  document?: DocRef;
  /** important : dit à voix haute ; normal : notification ; silence : rien (défaut : normal). */
  annonce?: "important" | "normal" | "silence";
}

/**
 * Un plugin qui a des tâches les déclare dans son manifeste (`tasks`) et fournit ce service. Le noyau les lance
 * (horloge du plugin Planificateur, voix…), une à la fois, et annonce le résultat : la tâche ne connaît ni l'horloge ni les corps.
 */
export interface TaskService {
  run(taskId: string, input: TaskRunInput): Promise<TaskResult>;
}

// ------------------------------------------------------------------ notifications (Telegram, mail…)
/** Ce qu'on envoie : un titre et un texte Markdown (le canal le met en forme : HTML pour un mail, message Telegram…). */
export interface NotifyMessage {
  titre: string;
  markdown: string;
}

/**
 * Un canal d'envoi configuré (ex. « Telegram · mon canal », « Gmail · perso »). Offert élément par élément
 * (ctx.offer("notify")) : un plugin les liste (ctx.offers) et en emprunte un le temps d'un envoi (ctx.borrowItem).
 * Envoyer, c'est sortir de chez l'utilisateur : celui qui envoie a l'accord (réglage choisi, ou outil de niveau « send »).
 */
export interface NotifyService {
  label?: string;
  cloud?: boolean;
  send(msg: NotifyMessage, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface Services {
  [name: string]: unknown;
  notify: NotifyService;
  search: SearchService;
  completion: CompletionService;
  documents: DocumentsService;
  task: TaskService;
  llm: LlmService;
  brain: BrainService;
  /** Gros cerveau pour la délégation (montage A) : CLI Claude ou Codex. */
  delegate: BrainService;
  memory: MemoryService;
  voice: VoiceService;
  tts: TtsService;
  vad: VadService;
  stt: SttService;
  live: LiveService;
  wakeword: WakewordService;
  coder: CoderService;
  mcp: McpEndpoint;
  body: BodyHub;
  avatars: AvatarRegistry;
}
