// Accords : le noyau décide, jamais le modèle.
// - Règle par niveau d'outil (always / ask / never), la plus stricte gagne.
// - « ask » : une demande avec un id secret et une durée de vie. Pas de réponse = refus.
// - Le modèle ne voit jamais l'id : seuls les corps (via le bus) peuvent répondre.
import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { Audit } from "./audit.ts";
import type { ApprovalSettings, Level, Rule } from "./config/schema.ts";
import { tr, type Text } from "./i18n.ts";

export interface ApprovalInput {
  tool: string;
  args: unknown;
  level: Level;
  /** Phrase courte montrée et dite à l'utilisateur (« Ouvrir https://… ? ») : texte simple ou { fr, en }. */
  summary: Text;
  /** Règle propre à l'outil (config du serveur MCP). Ne peut que durcir la règle du niveau. */
  override?: Rule;
  /** Corps d'origine du tour (pour le routage de la demande). */
  origin?: string;
  signal?: AbortSignal;
}

export interface ApprovalRequest extends Omit<ApprovalInput, "override" | "signal" | "summary"> {
  /** Dans la langue de l'assistant. */
  summary: string;
  id: string;
  ttl_s: number;
  expiresAt: number;
}

export type DecisionReason = "policy-always" | "policy-never" | "user" | "timeout" | "cancelled";
export interface Decision {
  ok: boolean;
  reason: DecisionReason;
  by?: string;
}

const STRICTNESS: Record<Rule, number> = { always: 0, ask: 1, never: 2 };

export function strictest(...rules: (Rule | undefined)[]): Rule {
  let out: Rule = "always";
  for (const r of rules) if (r && STRICTNESS[r] > STRICTNESS[out]) out = r;
  return out;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}

export class ApprovalManager {
  private pendingMap = new Map<string, Pending>();
  private settings: ApprovalSettings;
  private readonly bus: Bus;
  private readonly audit: Audit;

  /** Langue de l'assistant (résumés des demandes). Donnée par le noyau. */
  lang: () => string = () => "fr";

  constructor(bus: Bus, audit: Audit, settings: ApprovalSettings) {
    this.bus = bus;
    this.audit = audit;
    this.settings = settings;
  }

  setSettings(s: ApprovalSettings): void {
    this.settings = s;
  }

  ruleFor(level: Level, override?: Rule): Rule {
    return strictest(this.settings[level], override);
  }

  /** Applique la règle, et demande à l'utilisateur si besoin. */
  async check(input: ApprovalInput): Promise<Decision> {
    const rule = this.ruleFor(input.level, input.override);
    let decision: Decision;
    if (input.signal?.aborted) decision = { ok: false, reason: "cancelled" };
    else if (rule === "never") decision = { ok: false, reason: "policy-never" };
    else if (rule === "always") decision = { ok: true, reason: "policy-always" };
    else decision = await this.request(input);
    this.audit.write({ kind: "approval", tool: input.tool, level: input.level, rule, ok: decision.ok, reason: decision.reason, by: decision.by });
    return decision;
  }

  private request(input: ApprovalInput): Promise<Decision> {
    const ttl_s = this.settings.timeout_s;
    const req: ApprovalRequest = {
      id: randomUUID(), tool: input.tool, args: input.args, level: input.level, summary: tr(input.summary, this.lang()),
      ttl_s, expiresAt: Date.now() + ttl_s * 1000,
      ...(input.origin ? { origin: input.origin } : {}),
    };
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.close(req.id, { ok: false, reason: "timeout" }), ttl_s * 1000);
      this.pendingMap.set(req.id, { req, resolve, timer });
      if (input.signal) {
        const abort = () => this.close(req.id, { ok: false, reason: "cancelled" });
        input.signal.addEventListener("abort", abort, { once: true });
        this.pendingMap.get(req.id)!.cleanup = () => input.signal?.removeEventListener("abort", abort);
        if (input.signal.aborted) { abort(); return; }
      }
      this.bus.emit("approval.request", req);
    });
  }

  /** Réponse d'un corps. Retourne false si la demande n'existe plus (déjà répondue ou expirée). */
  respond(id: string, ok: boolean, by: string): boolean {
    return this.close(id, { ok, reason: "user", by });
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingMap.values()].map((p) => p.req);
  }

  /** Refuse toutes les demandes en cours (arrêt du noyau, tour annulé). */
  cancelAll(): void {
    for (const id of [...this.pendingMap.keys()]) this.close(id, { ok: false, reason: "cancelled" });
  }

  private close(id: string, d: Decision): boolean {
    const p = this.pendingMap.get(id);
    if (!p) return false;
    this.pendingMap.delete(id);
    clearTimeout(p.timer);
    p.cleanup?.();
    p.resolve(d);
    this.bus.emit("approval.closed", { id, ok: d.ok, reason: d.reason, ...(d.by ? { by: d.by } : {}) });
    return true;
  }
}
