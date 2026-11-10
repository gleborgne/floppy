// Une consigne vise un agent précis, figé avant l'accord puis revérifié avant l'envoi.
import { randomUUID } from "node:crypto";
import { T, TextError, type Context, type ToolCallMeta, type ToolDef, type ToolOutput } from "@floppy/core";
import type { Hit, OrcaCli, OrcaRunner } from "./index.ts";
import { isWorker } from "./speech.ts";
import { deliveryAudit, deliveryMeta, exactTerminal, incarnation, instruction, permissionMenu, receiptOf, recipientLabel, turnEndEvidence, type DeliveryCallbacks, type DeliveryFact } from "./send-support.ts";
import { checkoutProtection, protectionIdentity, type ProtectionIdentity, type ProtectionOptions } from "./checkout-protection.ts";

export interface SendDeps extends DeliveryCallbacks {
  ctx: Context;
  cli: OrcaCli;
  run: OrcaRunner;
  direct: () => boolean;
  target: (wts: Awaited<ReturnType<OrcaRunner>>, nom: string, meta: ToolCallMeta) => Hit | ToolOutput;
  protection?: ProtectionOptions;
}
interface Prepared { worktreeId: string; paneKey: string; terminal: string; terminalIdentity: string; protection: ProtectionIdentity; label: string; message: string; identity: string; state?: string; correlationId: string; at: number; meta: Pick<DeliveryFact, "callId" | "session" | "turn"> }

export function sendTool({ ctx, cli, run, direct, target, onDelivery, diagnostic, label, protection }: SendDeps): ToolDef {
  const guard = checkoutProtection(ctx, protection);
  const record = (p: Prepared, stage: DeliveryFact["stage"], requestId?: string, reason?: string) => {
    const fact: DeliveryFact = { correlationId: p.correlationId, planId: p.correlationId, worktreeId: p.worktreeId, paneKey: p.paneKey, stage, requestId, reason, at: Date.now(), elapsedMs: Date.now() - p.at, snapshotState: p.state, ...p.meta };
    ctx.audit.write(deliveryAudit(fact));
    try { onDelivery?.({ ...fact }); } catch { /* Le diagnostic ne modifie jamais le transport. */ }
    try { diagnostic?.({ ...fact }); } catch { /* Les observateurs sont indépendants. */ }
  };
  const prepared = new WeakMap<Record<string, unknown>, Prepared>();
  const missing = (label?: string) => new TextError(T(`${label ? `${label} : cet` : "Cet"} agent n'a plus de terminal identifiable dans Orca. Aucun message envoyé.`, `${label ? `${label}: this` : "This"} agent no longer has an identifiable terminal in Orca. No message sent.`));

  ctx.hook("tool.before", async (input, next) => {
    if (input.name !== "orca_send" || input.tool.source !== ctx.id) return next(input);
    const message = instruction(input.args.message);
    if (!direct()) throw new TextError(T("Envoi impossible : règle le chemin vers le programme Orca, sans script intermédiaire.", "Cannot send: set the path to the Orca program, without an intermediate script."));
    const hit = target(await run(), String(input.args.name ?? ""), input.meta);
    if (!("a" in hit)) throw new TextError(hit.text);
    if (!hit.a.agentType) throw new TextError(T("L'identité de cet agent est inconnue. Aucun message envoyé.", "This agent's identity is unknown. No message sent."));
    if (isWorker(hit.a)) throw new TextError(T("Cet agent est piloté par un coordinateur. Adresse la consigne à son coordinateur.", "This agent is managed by a coordinator. Send the instruction to its coordinator."));
    if (permissionMenu(hit.a)) throw new TextError(T("Cet agent attend une permission. Réponds dans Orca ; aucune permission n'est validée ici.", "This agent is awaiting permission. Answer in Orca; no permission is approved here."));
    const terminal = await exactTerminal(cli, hit.w.worktreeId, hit.a.paneKey);
    const p: Prepared = {
      worktreeId: hit.w.worktreeId, paneKey: hit.a.paneKey,
      terminal: terminal.handle, terminalIdentity: incarnation(terminal),
      protection: protectionIdentity(hit, terminal),
      label: recipientLabel(hit, label), message, meta: deliveryMeta(input.meta),
      identity: incarnation(hit.a), state: hit.a.state, correlationId: randomUUID(), at: Date.now(),
    };
    record(p, "selected");
    // Arguments propres à cet appel : deux accords simultanés ne partagent jamais leur cible.
    const args = { ...input.args };
    prepared.set(args, p);
    try { const result = await next({ ...input, args }); if (result.status === "refused") record(p, "refused"); return result; }
    finally { prepared.delete(args); }
  });

  return {
    name: "orca_send",
    description: "Envoie une consigne à un agent de code Orca déjà ouvert, après l'accord de l'utilisateur. À utiliser pour « dis-lui de commit », « demande-lui de corriger les tests », « dis-lui de continuer ». message : la consigne demandée par l'utilisateur, sur une seule ligne. name : projet ou tâche tel que dicté ; omettre pour l'agent annoncé en dernier, sinon le seul qui attend. Si plusieurs agents correspondent, demander lequel. Ne pas utiliser pour valider un menu de permissions ni pour piloter un worker d'orchestration. Un envoi accepté ne prouve pas que la tâche est faite ; ne pas renvoyer automatiquement.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, message: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["message"] },
    level: "send",
    auditArgs: () => ({ redacted: true }),
    summary: (args) => {
      const p = prepared.get(args)!;
      return T(`Envoyer à l'agent de ${p.label}${guard.waiting(p.protection.checkout) ? " (dossier en attente de preuve)" : ""} : « ${p.message} » ?`, `Send to the agent in ${p.label}${guard.waiting(p.protection.checkout) ? " (checkout awaiting evidence)" : ""}: “${p.message}”?`);
    },
    handler: async (args, meta) => {
      const p = prepared.get(args);
      if (!p) throw missing();
      await guard.reconcile(new Set([p.protection.checkout]), cli, run);
      const wts = await run();
      const w = wts.find(w => w.worktreeId === p.worktreeId);
      const current = w?.agents?.find(a => a.paneKey === p.paneKey);
      const reason = !current ? "agent-gone" : isWorker(current) ? "coordinator-managed" : permissionMenu(current) ? "permission-menu" : incarnation(current) !== p.identity ? "session-replaced" : undefined;
      if (reason) { record(p, "skipped", undefined, reason); throw missing(p.label); }
      let terminal;
      try { terminal = await exactTerminal(cli, p.worktreeId, p.paneKey); }
      catch { record(p, "skipped", undefined, "terminal-unavailable"); throw missing(p.label); }
      if (terminal.handle !== p.terminal || incarnation(terminal) !== p.terminalIdentity || incarnation(current!) !== p.identity) { record(p, "skipped", undefined, "terminal-replaced"); throw missing(p.label); }
      if (protectionIdentity({ w: w!, a: current! }, terminal).checkout !== p.protection.checkout) { record(p, "skipped", undefined, "state-changed"); throw missing(p.label); }
      if (current!.state === "working" && p.state !== "working") { record(p, "skipped", undefined, "state-changed"); return { status: "failed", text: T(`${p.label} travaille à nouveau. Aucun message envoyé.`, `${p.label} is working again. No message sent.`) }; }
      if (meta.signal?.aborted) { record(p, "cancelled"); meta.signal.throwIfAborted(); }
      const lease = guard.acquire(p.protection, p.correlationId, turnEndEvidence(current!).at, current!.state === "working", current!);
      if (!lease) {
        const reason = guard.failure(p.protection.checkout);
        record(p, "deferred", undefined, reason);
        return { status: "failed", text: reason === "checkout-unconfirmed" ? T(`${p.label} : le dossier attend encore une preuve de fin du précédent envoi. Aucun message envoyé.`, `${p.label}: the checkout still awaits evidence that the previous delivery ended. No message sent.`) : reason === "protection-capacity" ? T("Limite de dossiers protégés atteinte. Aucun message envoyé.", "Protected checkout limit reached. No message sent.") : T("Protection des dossiers indisponible. Aucun envoi ; vérifie les diagnostics.", "Checkout protection unavailable. No delivery; check diagnostics.") };
      }
      try {
        record(p, "sending");
        const r = receiptOf(await cli(["terminal", "send", "--terminal", p.terminal, "--text", p.message, "--enter"]));
        guard.receipt(p.protection.checkout, lease, r);
        if (r.stage !== "unknown") record(p, r.stage, r.requestId);
        if (r.stage === "turn_started") return { status: "done", text: T(`Nouveau tour démarré pour l'agent de ${p.label}. Cela ne confirme pas qu'il a exécuté la consigne.`, `A new turn started for the agent in ${p.label}. This does not confirm it has carried out the instruction.`) };
        if (r.stage === "input_accepted") return { status: "done", text: T(`Entrée acceptée par l'agent de ${p.label}, démarrage non confirmé. Cela ne confirme pas qu'il a exécuté la consigne.`, `Input accepted by the agent in ${p.label}, turn start unconfirmed. This does not confirm it has carried out the instruction.`) };
        if (r.stage === "refused") return { status: "failed", text: T(`Orca a refusé la consigne pour ${p.label}. Aucun nouvel envoi effectué.`, `Orca refused the instruction for ${p.label}. No further send attempted.`) };
      } catch { guard.receipt(p.protection.checkout, lease); /* Une erreur de transport peut survenir après l'acceptation : ne jamais renvoyer. */ }
      record(p, "unknown");
      return { status: "unverified", text: T(`Je n'ai pas pu confirmer l'envoi à ${p.label}. Vérifie cet agent avant de réessayer : il a peut-être reçu la consigne.`, `I could not confirm delivery to ${p.label}. Check this agent before retrying: it may have received the instruction.`) };
    },
  };
}
