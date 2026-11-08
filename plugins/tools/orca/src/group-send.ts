// Une sélection figée, un accord ; le dossier reste verrouillé jusqu'à la fin observée du nouveau tour.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { T, TextError, corruptFiles, readJsonFile, writeJsonAtomic, type Context, type Text, type ToolCallInput, type ToolCallMeta, type ToolDef, type ToolOutput, type ToolResult } from "@floppy/core";
import type { Hit, OrcaCli, OrcaRunner, OrcaTerminal } from "./index.ts";
import { isWorker } from "./speech.ts";
import { deliveryAudit, deliveryMeta, exactTerminal, findExactTerminal, humanLabel, incarnation, instruction, permissionMenu, receiptOf, recipientLabel, turnEndEvidence, STAGE_TEXT, type DeliveryCallbacks, type DeliveryFact, type DeliveryStage } from "./send-support.ts";
import { checkoutProtection, protectionIdentity, type ProtectionIdentity, type ProtectionOptions } from "./checkout-protection.ts";
export type { DeliveryFact } from "./send-support.ts";

export interface GroupSendDeps extends DeliveryCallbacks {
  ctx: Context;
  cli: OrcaCli;
  run: OrcaRunner;
  direct: () => boolean;
  /** Résolution exacte et cloisonnée par conversation ; jamais un élargissement après accord. */
  select: (wts: Awaited<ReturnType<OrcaRunner>>, args: Record<string, unknown>, meta: ToolCallMeta) => Hit[] | ToolOutput;
  announce?: (text: Text) => void;
  now?: () => number;
  protection?: ProtectionOptions;
  pollMs?: number;
  timeoutMs?: number;
  persistenceDiagnostic?: (fact: { reason: "read-failed" | "write-failed" | "invalid-summary" | "corrupt-summary"; at: number }) => void;
  /** Même contrat que les fichiers atomiques ; injectable pour simuler les pannes. */
  persistence?: { read(file: string): unknown; write(file: string, value: unknown): void };
}
interface Recipient {
  worktreeId: string; paneKey: string; label: string; checkout: string; identity: string; protection: ProtectionIdentity; lease?: string;
  terminal: OrcaTerminal; terminalIdentity: string; snapshotState?: string; stage: DeliveryStage;
  at: number; sentAt?: number; requestId?: string; reason?: string; started: boolean; observedState?: string; previousStage?: DeliveryStage;
}
interface Plan { id: string; owner: string; at: number; message: string; recipients: Recipient[]; cancelled: boolean; announced?: boolean; meta: Pick<DeliveryFact, "callId" | "session" | "turn"> }
interface StoredPlan { id: string; owner: string; at: number; recipients: { label: string; stage: DeliveryStage; reason?: string; requestId?: string; previousStage?: DeliveryStage }[] }
const AGE = 48 * 60 * 60 * 1000;
const FINAL = new Set<DeliveryStage>(["completed", "refused", "skipped", "deferred", "unknown", "timeout", "cancelled"]);
const owner = (m: ToolCallMeta): string => JSON.stringify([m.origin ?? "", m.session ?? ""]);
const keyOf = (r: Recipient): string => `${r.worktreeId}:${r.paneKey}`;
const clipped = (s: string): string => s.slice(0, 240);
const REASONS: Record<string, { fr: string; en: string }> = {
    "agent-gone": T("agent disparu", "agent gone"), "session-replaced": T("session remplacée", "session replaced"),
    "coordinator-managed": T("piloté par un coordinateur", "managed by a coordinator"), "permission-menu": T("permission à traiter dans Orca", "permission must be handled in Orca"),
    "terminal-replaced": T("terminal remplacé", "terminal replaced"), "terminal-unavailable": T("terminal indisponible", "terminal unavailable"),
    "state-changed": T("état modifié depuis l'accord", "state changed since approval"), "checkout-unconfirmed": T("tour précédent non confirmé dans ce dossier", "previous turn unconfirmed in this checkout"),
    "transport-unknown": T("accusé de transport inconnu", "unknown transport receipt"), "observation-unavailable": T("observation indisponible", "observation unavailable"),
    "start-unconfirmed": T("démarrage non confirmé", "start unconfirmed"), "completion-timeout": T("fin non observée dans le délai", "completion not observed within the deadline"),
    "observed-turn-end-not-work-success": T("fin observée, travail non vérifié", "end observed, work unverified"), "restart-no-replay": T("arrêt précédent, aucun renvoi", "previous shutdown, no replay"),
    "approval-refused": T("accord refusé", "approval refused"), "cancelled-before-send": T("annulé avant envoi", "cancelled before delivery"), "cancelled-observation-only": T("suivi annulé, agent non interrompu", "observation cancelled, agent not interrupted"),
    "cancelled-during-send": T("annulé pendant le transport, réception incertaine, agent non interrompu", "cancelled during transport, receipt unknown, agent not interrupted"),
    "protection-unavailable": T("protection des dossiers indisponible, aucun envoi", "checkout protection unavailable, no delivery"),
    "protection-capacity": T("limite de dossiers protégés atteinte, aucun envoi", "protected checkout limit reached, no delivery"),
};
function reasonText(reason: string): { fr: string; en: string } {
  return REASONS[reason] ?? T("état non vérifié", "state unverified");
}

function restoreHistory(value: unknown, at: number): StoredPlan[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is StoredPlan => {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || p.id.length > 80 || typeof p.owner !== "string" || p.owner.length > 4096) return false;
    if (typeof p.at !== "number" || !Number.isFinite(p.at) || at - p.at >= AGE || p.at > at || !Array.isArray(p.recipients) || p.recipients.length > 40) return false;
    return p.recipients.every((r: unknown) => !!r && typeof r === "object" && "label" in r && typeof r.label === "string" && "stage" in r && typeof r.stage === "string" && Object.hasOwn(STAGE_TEXT, r.stage));
  }).slice(-20).map(p => ({ id: p.id, owner: p.owner, at: p.at, recipients: p.recipients.map(r => ({
    label: humanLabel(r.label) || "Agent", stage: FINAL.has(r.stage) ? r.stage : "deferred",
    reason: FINAL.has(r.stage) ? r.reason && Object.hasOwn(REASONS, r.reason) ? r.reason : undefined : "restart-no-replay",
    previousStage: !FINAL.has(r.stage) ? r.stage : r.previousStage && Object.hasOwn(STAGE_TEXT, r.previousStage) ? r.previousStage : undefined,
    requestId: typeof r.requestId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(r.requestId) ? r.requestId : undefined,
  })) }));
}

export function groupSendTools(deps: GroupSendDeps): ToolDef[] {
  const { ctx, cli, run, direct, select } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = Math.min(30 * 60_000, Math.max(1, deps.timeoutMs ?? 10 * 60_000));
  const pollMs = Math.max(1, deps.pollMs ?? 1000);
  const guard = checkoutProtection(ctx, { now, ...deps.protection });
  const plans = new Map<string, Plan>();
  const frozen = new WeakMap<Record<string, unknown>, Plan>();
  const cancellations = new WeakMap<Record<string, unknown>, Plan>();
  // Porteurs locaux pour la file ; seul le registre partagé autorise un transport.
  const locks = new Map<string, { plan: string; recipient: string; evidence: Recipient }>();
  const file = join(ctx.home, "orca-deliveries.json");
  let stopped = false;
  let scheduled = false;
  let busy = false;
  let history: StoredPlan[] = [];
  let readable = true;
  const persistence = deps.persistence ?? { read: readJsonFile, write: writeJsonAtomic };
  const reported = new Set<string>();
  const persistenceProblem = (reason: Parameters<NonNullable<GroupSendDeps["persistenceDiagnostic"]>>[0]["reason"]) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    const fact = { reason, at: now() };
    ctx.audit.write({ kind: "orca.delivery.persistence", ...fact });
    try { deps.persistenceDiagnostic?.(fact); } catch { /* Un observateur ne relance aucun transport. */ }
  };
  let saved: unknown;
  try {
    const corruptBefore = corruptFiles().length;
    saved = persistence.read(file);
    if (corruptFiles().slice(corruptBefore).some(entry => entry.file === file)) persistenceProblem("corrupt-summary");
    if (saved !== undefined && !Array.isArray(saved)) persistenceProblem("invalid-summary");
    history = restoreHistory(saved, now());
  } catch { readable = false; persistenceProblem("read-failed"); }
  if (saved !== undefined) { try { persistence.write(file, history); } catch { persistenceProblem("write-failed"); } }
  const snapshots = (): StoredPlan[] => {
    const live = [...plans.values()].map(p => ({ id: p.id, owner: p.owner, at: p.at, recipients: p.recipients.map(r => ({ label: clipped(r.label), stage: r.stage, reason: r.reason, requestId: r.requestId, previousStage: r.previousStage })) }));
    const ids = new Set(live.map(p => p.id));
    return [...history.filter(p => !ids.has(p.id)), ...live].filter(p => now() - p.at < AGE).slice(-20);
  };
  const persist = () => { if (!readable) return; try { persistence.write(file, snapshots()); } catch { persistenceProblem("write-failed"); } };
  const record = (p: Plan, r: Recipient, stage: DeliveryStage, reason?: string) => {
    r.stage = stage; r.reason = reason;
    const correlationId = `${p.id}:${createHash("sha256").update(keyOf(r)).digest("hex").slice(0, 24)}`;
    const provenance = stage === "selected" ? "approval-selection" : ["input_accepted", "refused", "unknown"].includes(stage) && !r.observedState ? "cli-receipt" : r.observedState ? "cli-snapshot" : "local-plan";
    const fact: DeliveryFact = { correlationId, planId: p.id, requestId: r.requestId, worktreeId: r.worktreeId, paneKey: r.paneKey, stage, at: now(), elapsedMs: now() - r.at, reason, snapshotState: r.snapshotState, observedState: r.observedState, provenance, ...p.meta };
    ctx.audit.write(deliveryAudit(fact));
    try { deps.onDelivery?.({ ...fact }); } catch { /* Observateur isolé du transport. */ }
    try { deps.diagnostic?.({ ...fact }); } catch { /* Observateur isolé du transport. */ }
    persist();
  };
  const describe = (p: StoredPlan) => T(`${p.recipients.map(r => `${r.label} : ${STAGE_TEXT[r.stage].fr}${r.previousStage ? ` ; dernière étape : ${STAGE_TEXT[r.previousStage].fr}` : ""}${r.reason ? ` (${reasonText(r.reason).fr})` : ""}`).join("\n")}`, `${p.recipients.map(r => `${r.label}: ${STAGE_TEXT[r.stage].en}${r.previousStage ? `; last stage: ${STAGE_TEXT[r.previousStage].en}` : ""}${r.reason ? ` (${reasonText(r.reason).en})` : ""}`).join("\n")}`);
  const spokenSummary = (p: StoredPlan): Text => {
    const stage = (r: StoredPlan["recipients"][number]) => r.stage === "completed" ? T("tour terminé, travail non vérifié", "turn ended, work unverified") : r.stage === "timeout" ? T("suivi expiré, fin non confirmée", "tracking timed out, completion unconfirmed") : r.stage === "unknown" ? T("réception incertaine, aucun nouvel envoi", "receipt uncertain, no resend") : STAGE_TEXT[r.stage];
    return T(p.recipients.map(r => `${r.label} : ${stage(r).fr}${r.stage === "skipped" && r.reason ? `, ${reasonText(r.reason).fr}` : ""}.`).join(" "), p.recipients.map(r => `${r.label}: ${stage(r).en}${r.stage === "skipped" && r.reason ? `, ${reasonText(r.reason).en}` : ""}.`).join(" "));
  };
  const rawPlan = (p: StoredPlan) => ({ planId: p.id, at: p.at, recipients: p.recipients, modelHint: "Identifiants internes : ne jamais les prononcer ; utiliser les noms de tâches et projets." });
  const finish = (p: Plan) => {
    if (p.announced || !p.recipients.every(r => FINAL.has(r.stage))) return;
    p.announced = true;
    const snapshot = snapshots().find(s => s.id === p.id)!;
    try { deps.announce?.(spokenSummary(snapshot)); } catch { /* Une annonce ne relance jamais le plan. */ }
    p.message = "";
  };
  const cancel = (p: Plan) => {
    p.cancelled = true;
    for (const r of p.recipients) if (!FINAL.has(r.stage)) {
      r.previousStage = r.stage;
      record(p, r, "cancelled", r.sentAt === undefined ? "cancelled-before-send" : r.stage === "sending" ? "cancelled-during-send" : "cancelled-observation-only");
      const lock = locks.get(r.checkout);
      if (r.sentAt === undefined && lock?.plan === p.id && lock.recipient === keyOf(r)) locks.delete(r.checkout);
    }
    finish(p);
  };
  ctx.effect(() => { stopped = true; for (const p of plans.values()) cancel(p); });
  const revalidate = async (r: Recipient) => {
    const rows = await run();
    const w = rows.find(w => w.worktreeId === r.worktreeId);
    const a = w?.agents?.find(a => a.paneKey === r.paneKey);
    if (!a) return { reason: "agent-gone" };
    if (incarnation(a) !== r.identity) return { reason: "session-replaced" };
    if (isWorker(a)) return { reason: "coordinator-managed" };
    if (permissionMenu(a)) return { reason: "permission-menu" };
    const t = await exactTerminal(cli, r.worktreeId, r.paneKey);
    if (t.handle !== r.terminal.handle || incarnation(t) !== r.terminalIdentity) return { reason: "terminal-replaced" };
    if (incarnation(a) !== r.identity) return { reason: "session-replaced" };
    if (protectionIdentity({ w: w!, a }, t).checkout !== r.checkout) return { reason: "state-changed" };
    return { a, w: w!, terminal: t };
  };
  const unsubscribe = guard.onRelease((checkout, reason, state) => {
    const holder = locks.get(checkout)?.evidence;
    if (reason !== "transport-refused") {
      const expired = holder?.sentAt !== undefined && now() - holder.sentAt >= timeoutMs;
      if (!holder || FINAL.has(holder.stage) || expired) {
        const p = locks.get(checkout) && plans.get(locks.get(checkout)!.plan);
        if (holder && p && !FINAL.has(holder.stage)) record(p, holder, "timeout", holder.started ? "completion-timeout" : "start-unconfirmed");
        for (const p of plans.values()) for (const r of p.recipients) if (r.checkout === checkout && r.stage === "queued") record(p, r, "deferred", "checkout-unconfirmed");
      } else {
        const p = plans.get(locks.get(checkout)!.plan);
        if (state) holder.observedState = state;
        if (p) record(p, holder, "completed", "observed-turn-end-not-work-success");
      }
    }
    locks.delete(checkout);
  });
  ctx.effect(unsubscribe);
  const processRecipient = async (p: Plan, r: Recipient) => {
    if (stopped || p.cancelled || FINAL.has(r.stage)) return;
    if (r.stage === "queued") {
      const lock = locks.get(r.checkout);
      if (lock && (lock.plan !== p.id || lock.recipient !== keyOf(r))) {
        const other = lock.evidence;
        if (!other || FINAL.has(other.stage)) record(p, r, "deferred", "checkout-unconfirmed");
        return;
      }
      let current;
      try { current = await revalidate(r); } catch { current = { reason: "terminal-unavailable" }; }
      if (stopped || p.cancelled) { if (!p.cancelled) cancel(p); return; }
      if (FINAL.has(r.stage)) return;
      if (!current.a || current.a.state !== r.snapshotState || current.a.state === "working") {
        r.observedState = current.a?.state;
        record(p, r, "skipped", current.reason ?? "state-changed");
        locks.delete(r.checkout);
        return;
      }
      r.lease = guard.acquire(r.protection, `${p.id}:${keyOf(r)}`, turnEndEvidence(current.a).at, false, current.a);
      if (!r.lease) { record(p, r, "deferred", guard.failure(r.checkout)); return; }
      locks.set(r.checkout, { plan: p.id, recipient: keyOf(r), evidence: r });
      r.sentAt = now();
      record(p, r, "sending");
      try {
        // La réception est immédiate ; la surveillance bornée ci-dessous reste compatible avec les anciens hôtes.
        const result = receiptOf(await cli(["terminal", "send", "--terminal", r.terminal.handle, "--text", p.message, "--enter"]));
        guard.receipt(r.checkout, r.lease, result);
        r.requestId = result.requestId;
        r.started = result.stage === "turn_started";
        if (stopped || p.cancelled) return;
        record(p, r, result.stage);
        if (result.stage === "refused") locks.delete(r.checkout);
      } catch { guard.receipt(r.checkout, r.lease); if (!stopped && !p.cancelled) record(p, r, "unknown", "transport-unknown"); }
      return;
    }
    if (now() - (r.sentAt ?? r.at) >= timeoutMs) { record(p, r, "timeout", r.started ? "completion-timeout" : "start-unconfirmed"); return; }
    try {
      const current = await revalidate(r);
      if (stopped || p.cancelled) { if (!p.cancelled) cancel(p); return; }
      if (FINAL.has(r.stage)) return;
      if (!current.a) { record(p, r, "unknown", current.reason); return; }
      r.observedState = current.a.state;
      const released = guard.observe({ w: current.w!, a: current.a }, current.terminal!, r.lease!);
      if (current.a.state === "working") {
        if (!r.started) { r.started = true; record(p, r, "turn_started"); }
      } else if (/^(done|completed|idle)$/i.test(current.a.state ?? "")) {
        if (!released) return;
        if (r.stage !== "completed") record(p, r, "completed", "observed-turn-end-not-work-success");
        locks.delete(r.checkout);
      }
    } catch { record(p, r, "unknown", "observation-unavailable"); }
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    ctx.timeout(() => { scheduled = false; void tick(); }, pollMs);
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      // Une opération par dossier à chaque passage ; les autres dossiers progressent indépendamment.
      const seen = new Set<string>();
      const work: Promise<void>[] = [];
      for (const p of plans.values()) for (const r of p.recipients) if (!FINAL.has(r.stage) && !seen.has(r.checkout)) {
        seen.add(r.checkout); work.push(processRecipient(p, r));
      }
      await Promise.allSettled(work);
      for (const p of plans.values()) if (p.message && p.recipients.every(r => FINAL.has(r.stage))) finish(p);
    } finally { busy = false; }
    if ([...plans.values()].some(p => p.recipients.some(r => !FINAL.has(r.stage)))) schedule();
  };
  ctx.hook<ToolCallInput, ToolResult>("tool.before", async (input, next) => {
    if (input.tool.source !== ctx.id) return next(input);
    if (input.name === "orca_annuler_envoi") {
      const p = plans.get(String(input.args.plan));
      if (!p || p.owner !== owner(input.meta)) throw new TextError(T("Plan introuvable dans cette conversation.", "Plan not found in this conversation."));
      const args = { ...input.args };
      cancellations.set(args, p);
      try { return await next({ ...input, args }); } finally { cancellations.delete(args); }
    }
    if (input.name !== "orca_envoyer_groupe") return next(input);
    input.meta.signal?.throwIfAborted();
    const message = instruction(input.args.message);
    if (!direct()) throw new TextError(T("Règle le chemin du programme Orca sans script intermédiaire.", "Set the path to the Orca program without an intermediate script."));
    const hits = select(await run(), input.args, input.meta);
    if (!Array.isArray(hits)) throw new TextError(hits.text);
    if (!hits.length || hits.length > 40) throw new TextError(T("Choisis entre 1 et 40 agents nommés.", "Choose between 1 and 40 named agents."));
    const at = now();
    const recipients: Recipient[] = [];
    const terminals = await cli(["terminal", "list"]) as { terminals?: OrcaTerminal[] } | undefined;
    for (const h of hits) {
      if (!h.a.agentType || !h.a.state) throw new TextError(T(`${recipientLabel(h, deps.label)} : identité inconnue. Aucun envoi.`, `${recipientLabel(h, deps.label)}: unknown identity. No delivery.`));
      const reason = isWorker(h.a) ? T("piloté par un coordinateur", "managed by a coordinator") : permissionMenu(h.a) ? T("attend une permission", "awaiting permission") : h.a.state === "working" ? T("travaille encore", "still working") : undefined;
      if (reason) throw new TextError(T(`${recipientLabel(h, deps.label)} : ${reason.fr}. Aucun envoi.`, `${recipientLabel(h, deps.label)}: ${reason.en}. No delivery.`));
      let terminal: OrcaTerminal;
      try { terminal = findExactTerminal(terminals?.terminals ?? [], h.w.worktreeId, h.a.paneKey); }
      catch { throw new TextError(T(`${recipientLabel(h, deps.label)} : terminal absent ou ambigu. Aucun envoi.`, `${recipientLabel(h, deps.label)}: terminal missing or ambiguous. No delivery.`)); }
      const protection = protectionIdentity(h, terminal);
      recipients.push({ protection, worktreeId: h.w.worktreeId, paneKey: h.a.paneKey, label: recipientLabel(h, deps.label), checkout: protection.checkout, identity: incarnation(h.a), terminal: { ...terminal }, terminalIdentity: incarnation(terminal), snapshotState: h.a.state, stage: "selected", at, started: false });
    }
    if (new Set(recipients.map(keyOf)).size !== recipients.length) throw new TextError(T("La sélection contient un agent en double.", "The selection contains a duplicate agent."));
    input.meta.signal?.throwIfAborted();
    const p: Plan = { id: randomUUID(), owner: owner(input.meta), at, message, recipients, cancelled: false, meta: deliveryMeta(input.meta) };
    const args = { ...input.args };
    frozen.set(args, p);
    for (const r of recipients) record(p, r, "selected");
    try {
      const result = await next({ ...input, args });
      if (result.status === "refused") for (const r of recipients) record(p, r, "refused", "approval-refused");
      return result;
    } finally { frozen.delete(args); }
  });
  return [{
    name: "orca_envoyer_groupe", level: "send",
    description: "Transmet une consigne identique à une sélection nommée d'agents Orca terminés, après UN accord collectif qui nomme chaque agent, tâche et projet. nom : projet/groupe ou référence précédente ; filtre : termines. Aucun worker piloté, menu de permission, agent en cours ou cible ambiguë. Les agents d'un même dossier passent après la fin observée du tour précédent. Consulter orca_envois pour les résultats ; ne jamais renvoyer sur silence.",
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 4000 }, nom: { type: "string" }, filtre: { type: "string" } }, required: ["message"] },
    auditArgs: () => ({ redacted: true }),
    summary: args => {
      const p = frozen.get(args)!;
      const names = (en: boolean) => p.recipients.map(r => `${r.label}${guard.waiting(r.checkout) ? en ? " (checkout awaiting evidence)" : " (dossier en attente de preuve)" : ""}`).join("\n");
      return T(`Envoyer à chacun de ces agents :\n${names(false)}\nConsigne exacte : « ${p.message} » ?`, `Send to each of these agents:\n${names(true)}\nExact instruction: “${p.message}”?`);
    },
    handler: async (args, meta) => {
      const p = frozen.get(args);
      if (!p || stopped) throw new TextError(T("Sélection expirée. Aucun envoi.", "Selection expired. No delivery."));
      meta.signal?.throwIfAborted();
      await guard.reconcile(new Set(p.recipients.map(r => r.checkout)), cli, run);
      meta.signal?.throwIfAborted();
      if (stopped) throw new TextError(T("Sélection expirée. Aucun envoi.", "Selection expired. No delivery."));
      if (!guard.available()) return { status: "failed", text: T("Protection des dossiers indisponible. Aucun envoi ; vérifie les diagnostics.", "Checkout protection unavailable. No delivery; check diagnostics.") };
      if ([...plans.values()].filter(p => p.recipients.some(r => !FINAL.has(r.stage))).length >= 20) return { status: "failed", text: T("Trop de plans en cours ou de dossiers non libérés.", "Too many active plans or unreleased checkouts.") };
      if (plans.size >= 20) { const old = [...plans.values()].find(p => p.recipients.every(r => FINAL.has(r.stage))); if (old) { history = snapshots(); plans.delete(old.id); } }
      plans.set(p.id, p);
      for (const r of p.recipients) record(p, r, "queued");
      schedule();
      return { status: "done", text: T(`Consigne mise en file pour ${p.recipients.map(r => r.label).join(" ; ")}. Aucun résultat du travail encore confirmé.`, `Instruction queued for ${p.recipients.map(r => r.label).join("; ")}. No work result confirmed yet.`), raw: rawPlan(snapshots().find(s => s.id === p.id)!) };
    },
  }, {
    name: "orca_envois", level: "read", description: "Liste les envois de cette conversation, nommés par agent/tâche/projet, avec leur étape exacte. Une fin de tour ne prouve jamais qu'un commit a réussi.",
    auditArgs: () => ({ redacted: true }),
    inputSchema: { type: "object", properties: { plan: { type: "string" } } },
    handler: async (args, meta) => {
      const rows = snapshots().filter(p => p.owner === owner(meta) && (!args.plan || p.id === args.plan));
      return { status: "done", text: rows.length ? T(rows.map(p => describe(p).fr).join("\n\n"), rows.map(p => describe(p).en).join("\n\n")) : T("Aucun plan d'envoi dans cette conversation.", "No delivery plan in this conversation."), raw: { plans: rows.map(rawPlan) } };
    },
  }, {
    name: "orca_annuler_envoi", level: "write", description: "Annule les envois encore en file de ce plan. N'interrompt jamais un agent ayant reçu la consigne et n'annule pas son travail.",
    auditArgs: () => ({ redacted: true }),
    summary: args => {
      const names = cancellations.get(args)?.recipients.map(r => r.label).join(" ; ");
      return names ? T(`Annuler les envois encore en attente pour ${names} ?`, `Cancel pending deliveries for ${names}?`) : T("Annuler ces envois encore en attente ?", "Cancel these pending deliveries?");
    },
    inputSchema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
    handler: async (args, meta) => {
      const p = plans.get(String(args.plan));
      if (!p || p.owner !== owner(meta)) return { status: "failed", text: T("Plan introuvable dans cette conversation.", "Plan not found in this conversation.") };
      cancel(p);
      const snapshot = snapshots().find(s => s.id === p.id)!;
      return { status: "done", text: describe(snapshot), raw: rawPlan(snapshot) };
    },
  }];
}
