// Agents externes : chaque plugin offre son agent ; les consommateurs empruntent celui demandé.
import type { BrainEvent, BrainRunInput } from "./brain.ts";

export interface AgentRunInput extends BrainRunInput {
  /** Choix ponctuel, sans modifier les réglages du cerveau. */
  model?: string;
}

export interface AgentService {
  id: string;
  label: string;
  aliases: string[];
  /** Prépare une session interactive avec les droits propres de l'agent. */
  interactive(input: { prompt: string; model?: string }): { command: string; args: string[] };
  /** Présent seulement si l'adaptateur sait limiter les outils au registre Floppy. */
  run?(input: AgentRunInput): AsyncIterable<BrainEvent>;
}

/** Faits observés, indépendants de l'outil qui suit les agents. Aucun texte n'est inventé par le consommateur. */
export interface AgentTrackingRecord {
  id: string;
  project: string;
  label: string;
  workspaceLabel?: string;
  activity: "working" | "waiting" | "finished" | "idle" | "unknown";
  outcome: "success" | "failure" | "interruption" | "unconfirmed" | "unknown";
  presence: "live" | "absent" | "unknown";
  observedAt: number;
  lastSeenAt: number;
  mission?: string;
  details?: string;
  progress?: string;
  waitingReason?: string;
  declaredResult?: string;
  lastAction?: string;
}

export interface AgentTrackingEvent {
  eventId: string;
  agentId: string;
  at: number;
  kind: string;
  summary?: string;
}

/** Métadonnées bornées seulement : jamais de prompt, message, chemin ou secret. */
export interface AgentTrackingDiagnostic {
  at: number;
  reason: string;
  correlationId?: string;
  component?: string;
  stage?: string;
  agentId?: string;
  eventId?: string;
  callId?: string;
}

export interface AgentTrackingSnapshot {
  at: number;
  agents: AgentTrackingRecord[];
  events: AgentTrackingEvent[];
  connection: {
    state: "connected" | "stale" | "offline" | "unknown";
    lastSyncAt?: number;
    coverage: "full" | "partial" | "outage" | "unknown";
  };
  diagnostics?: AgentTrackingDiagnostic[];
}

/** Le fournisseur conserve les observations ; une lecture ne commande jamais un agent. */
export interface AgentTrackingService {
  snapshot(): AgentTrackingSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(signal?: AbortSignal): Promise<void>;
}

declare module "@floppy/core" {
  interface Services {
    agent: AgentService;
    agentTracking: AgentTrackingService;
  }
}
