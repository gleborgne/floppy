// Miroir du contrat agents.ts : ne pas importer le noyau et ses globaux Node dans Chromium.
interface TrackingRecord {
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
interface TrackingSnapshot {
  at: number;
  agents: TrackingRecord[];
  events: { eventId: string; agentId: string; at: number; kind: string; summary?: string }[];
  connection: { state: "connected" | "stale" | "offline" | "unknown"; lastSyncAt?: number; coverage: "full" | "partial" | "outage" | "unknown" };
  diagnostics?: { at: number; reason: string; correlationId?: string; component?: string; stage?: string; agentId?: string; eventId?: string; callId?: string }[];
}
interface TrackingPayload { snapshot: TrackingSnapshot; lang: string }
