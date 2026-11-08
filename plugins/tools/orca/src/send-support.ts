import { createHash } from "node:crypto";
import { T, TextError, type ToolCallMeta } from "@floppy/core";
import type { Hit, OrcaAgent, OrcaCli, OrcaTerminal } from "./index.ts";

export type DeliveryStage = "selected" | "queued" | "sending" | "input_accepted" | "turn_started" | "completed" | "refused" | "skipped" | "deferred" | "unknown" | "timeout" | "cancelled";
/** Faits sans consigne : utilisables par le journal et le magasin d'activité. */
export interface DeliveryFact {
  correlationId: string;
  planId: string;
  requestId?: string;
  worktreeId: string;
  paneKey: string;
  stage: DeliveryStage;
  at: number;
  elapsedMs: number;
  reason?: string;
  snapshotState?: string;
  observedState?: string;
  provenance?: "approval-selection" | "cli-receipt" | "cli-snapshot" | "local-plan";
  callId?: string;
  session?: string;
  turn?: string;
}
export interface DeliveryCallbacks {
  onDelivery?: (fact: DeliveryFact) => void;
  diagnostic?: (fact: DeliveryFact) => void;
  /** Nom humain stable du magasin, jamais une identité technique. */
  label?: (hit: Hit) => string;
}
export const deliveryMeta = (meta: ToolCallMeta): Pick<DeliveryFact, "callId" | "session" | "turn"> => ({ callId: meta.callId, session: meta.session, turn: meta.turn });
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
/** Projection fermée : les identités brutes restent réservées aux callbacks internes. */
export function deliveryAudit(f: DeliveryFact): { kind: string } & Record<string, unknown> {
  const state = (value: string | undefined) => value && /^(working|running|done|finished|completed|idle|waiting|blocked|permission|interrupted|failed|unknown)$/.test(value) ? value : value === undefined ? undefined : "unknown";
  return { kind: "orca.delivery", correlationHash: hash(f.correlationId), planHash: hash(f.planId), agentHash: hash(JSON.stringify([f.worktreeId, f.paneKey])),
    requestHash: f.requestId ? hash(f.requestId) : undefined, callHash: f.callId ? hash(f.callId) : undefined, sessionHash: f.session ? hash(f.session) : undefined, turnHash: f.turn ? hash(f.turn) : undefined,
    stage: f.stage, at: f.at, elapsedMs: f.elapsedMs, reason: f.reason, snapshotState: state(f.snapshotState), observedState: state(f.observedState), provenance: f.provenance };
}
export function instruction(value: unknown): string {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message || message.length > 4000 || /^-/.test(message) || /[\x00-\x1f\x7f]/.test(message)) throw new TextError(T("Donne une consigne sur une seule ligne, de 1 à 4 000 caractères, sans tiret au début.", "Give an instruction on one line, between 1 and 4,000 characters, without a leading hyphen."));
  return message;
}
export const missingTarget = (): TextError => new TextError(T("Cet agent n'a plus de terminal identifiable dans Orca. Aucun message envoyé.", "This agent no longer has an identifiable terminal in Orca. No message sent."));
export async function exactTerminal(cli: OrcaCli, worktreeId: string, paneKey: string): Promise<OrcaTerminal> {
  const r = await cli(["terminal", "list"]) as { terminals?: OrcaTerminal[] } | undefined;
  return findExactTerminal(r?.terminals ?? [], worktreeId, paneKey);
}
export function findExactTerminal(terms: OrcaTerminal[], worktreeId: string, paneKey: string): OrcaTerminal {
  const matches = terms.filter(t => t.worktreeId === worktreeId && `${t.tabId}:${t.leafId}` === paneKey && /^term_[A-Za-z0-9-]{1,80}$/.test(t.handle));
  if (matches.length !== 1) throw missingTarget();
  return matches[0]!;
}
/** Les champs d'identité disponibles sont comparés, y compris lorsqu'ils disparaissent. */
export function incarnation(value: object): string {
  const v = value as Record<string, unknown>;
  const main = v.mainAgent && typeof v.mainAgent === "object" ? v.mainAgent as Record<string, unknown> : {};
  return JSON.stringify([v.agentId, v.sessionId, v.conversationId, v.agentSessionId, v.incarnation, v.processIncarnation, v.pid, v.startedAt, v.agentType, v.generation, main.id, main.sessionId, main.incarnation]);
}
export function permissionMenu(a: OrcaAgent): boolean {
  return /permission|approv/i.test(a.state ?? "") || /permission|approv/i.test(a.toolName ?? "");
}
export function humanLabel(value: string): string {
  return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "")
    .replace(/\b(?:term|pane|agent|worker-task|task|plan|request|req)[_:-][\w-]{6,}\b/gi, "")
    .replace(/(?:[A-Za-z]:[\\/]|(?:^|\s)(?:~?[\\/]))[^\s·,;)]+/g, " ").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}
export function recipientLabel(h: Hit, resolve?: (hit: Hit) => string): string {
  const privateValues = [h.w.worktreeId, h.a.paneKey, h.a.agentId, h.a.sessionId, h.a.incarnation].filter((v): v is string => !!v);
  const safe = (v: string | null | undefined) => humanLabel(privateValues.reduce((s, id) => s.replaceAll(id, ""), v ?? ""));
  const task = safe(resolve?.(h)) || safe(h.a.taskTitle) || safe(h.a.displayName) || safe(h.a.conversationName) || safe(h.a.agentType) || "Agent";
  const project = safe(h.w.repo) || safe(h.w.displayName);
  const workspace = safe(h.w.displayName);
  return [safe(h.a.displayName), task, project, workspace && workspace !== project && workspace !== task ? workspace : ""].filter((s, i, all) => s && all.indexOf(s) === i).join(" · ");
}
export interface TurnEndEvidence { at?: number; identified: boolean }
export function turnEndEvidence(a: OrcaAgent): TurnEndEvidence {
  const row = a as unknown as Record<string, unknown>;
  const at = row.turnEndedAt;
  return { at: typeof at === "number" && Number.isFinite(at) && at > 0 ? at : undefined, identified: row.turnEndDisposition === "identified" };
}
export interface Receipt { stage: "input_accepted" | "turn_started" | "refused" | "unknown"; requestId?: string }
export function receiptOf(value: unknown): Receipt {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const r = root.send && typeof root.send === "object" ? root.send as Record<string, unknown> : root;
  const nested = [r.prompt, r.receipt, r.submission, r.delivery].filter(v => v && typeof v === "object") as Record<string, unknown>[];
  const rows = [r, ...nested];
  const requestId = rows.map(v => v.requestId).find(v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v) && v !== "unsupported-old-host") as string | undefined;
  const stages = rows.flatMap(v => [v.stage, v.status, v.outcome, v.state, ...(Array.isArray(v.stages) ? v.stages : [])]);
  if (r.accepted === false || stages.includes("refused")) return { stage: "refused", requestId };
  if (stages.includes("turn_started") || rows.some(v => v.turnStarted === true)) return { stage: "turn_started", requestId };
  if (r.accepted === true || stages.includes("input_accepted")) return { stage: "input_accepted", requestId };
  return { stage: "unknown", requestId };
}
export const STAGE_TEXT: Record<DeliveryStage, { fr: string; en: string }> = {
  selected: T("sélectionné", "selected"), queued: T("en file", "queued"), sending: T("envoi en cours", "sending"), input_accepted: T("entrée acceptée, démarrage non confirmé", "input accepted, start unconfirmed"), turn_started: T("nouveau tour démarré", "new turn started"), completed: T("fin du tour observée, résultat du travail non vérifié", "turn completion observed, work result unverified"), refused: T("refusé", "refused"), skipped: T("ignoré", "skipped"), deferred: T("différé : dossier non libéré", "deferred: checkout not released"), unknown: T("transport incertain, aucun nouvel envoi", "transport unknown, no resend"), timeout: T("délai dépassé", "timed out"), cancelled: T("annulé", "cancelled"),
};
