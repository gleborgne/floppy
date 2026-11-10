// Choix dans une liste : le noyau demande à l'utilisateur de choisir UNE option, comme un accord (oui/non).
// - Une demande avec un id secret et une durée de vie. Pas de réponse = pas de choix (timeout).
// - Le modèle ne voit jamais l'id : seuls les corps (via le bus) répondent, et seulement avec une option de la liste.
import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { Audit } from "./audit.ts";
import { T, TextError, tr, type Text } from "./i18n.ts";

export interface ChoiceOptionInput { id: string; label: Text; detail?: Text }

export interface ChoiceInput {
  title: Text;
  options: ChoiceOptionInput[];
  /** Entrée qui pose la question, fixée par le noyau. */
  source?: string;
  /** Corps d'origine du tour (pour le routage de la demande). */
  origin?: string;
  /** Durée de vie en secondes (défaut 60, bornée à 5..600). */
  ttl_s?: number;
  signal?: AbortSignal;
}

export interface ChoiceRequest {
  id: string;
  /** Textes dans la langue de l'assistant. */
  title: string;
  options: { id: string; label: string; detail?: string }[];
  source?: string;
  origin?: string;
  ttl_s: number;
  expiresAt: number;
}

export type ChoiceReason = "user" | "timeout" | "cancelled";
export interface ChoiceResult { picked?: string; reason: ChoiceReason; by?: string }

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;

interface Pending {
  req: ChoiceRequest;
  resolve: (r: ChoiceResult) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}

export class ChoiceManager {
  private pendingMap = new Map<string, Pending>();
  private readonly bus: Bus;
  private readonly audit: Audit;

  /** Langue de l'assistant (titres et options). Donnée par le noyau. */
  lang: () => string = () => "fr";

  constructor(bus: Bus, audit: Audit) {
    this.bus = bus;
    this.audit = audit;
  }

  /** Pose la question et attend le choix. Une entrée invalide lève une TextError. */
  ask(input: ChoiceInput): Promise<ChoiceResult> {
    const n = input.options.length;
    if (n < MIN_OPTIONS || n > MAX_OPTIONS) throw new TextError(T(`Un choix demande entre ${MIN_OPTIONS} et ${MAX_OPTIONS} options (reçu : ${n}).`, `A choice needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got: ${n}).`));
    const seen = new Set<string>();
    for (const o of input.options) {
      if (!o.id) throw new TextError(T("Une option de choix a un identifiant vide.", "A choice option has an empty id."));
      if (seen.has(o.id)) throw new TextError(T(`Identifiant d'option en double : ${o.id}.`, `Duplicate option id: ${o.id}.`));
      seen.add(o.id);
    }
    const lang = this.lang();
    const ttl_s = Math.min(600, Math.max(5, input.ttl_s ?? 60));
    const req: ChoiceRequest = {
      id: randomUUID(),
      title: tr(input.title, lang),
      options: input.options.map((o) => ({ id: o.id, label: tr(o.label, lang), ...(o.detail !== undefined ? { detail: tr(o.detail, lang) } : {}) })),
      ttl_s, expiresAt: Date.now() + ttl_s * 1000,
      ...(input.source ? { source: input.source } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    };
    if (input.signal?.aborted) {
      this.record(req, { reason: "cancelled" });
      return Promise.resolve({ reason: "cancelled" });
    }
    return new Promise<ChoiceResult>((resolve) => {
      const timer = setTimeout(() => this.close(req.id, { reason: "timeout" }), ttl_s * 1000);
      const p: Pending = { req, resolve, timer };
      this.pendingMap.set(req.id, p);
      if (input.signal) {
        const abort = () => this.close(req.id, { reason: "cancelled" });
        input.signal.addEventListener("abort", abort, { once: true });
        p.cleanup = () => input.signal?.removeEventListener("abort", abort);
      }
      this.bus.emit("choice.request", req);
    });
  }

  /** Réponse d'un corps. false : demande inconnue ou fermée, ou option absente de la liste. */
  respond(id: string, option: string, by: string): boolean {
    const p = this.pendingMap.get(id);
    if (!p || !p.req.options.some((o) => o.id === option)) return false;
    return this.close(id, { picked: option, reason: "user", by });
  }

  pending(): ChoiceRequest[] {
    return [...this.pendingMap.values()].map((p) => p.req);
  }

  /** Annule toutes les demandes en cours (arrêt du noyau). */
  cancelAll(): void {
    for (const id of [...this.pendingMap.keys()]) this.close(id, { reason: "cancelled" });
  }

  private record(req: ChoiceRequest, r: ChoiceResult): void {
    this.audit.write({ kind: "choice", source: req.source, origin: req.origin, options: req.options.length, picked: r.picked, reason: r.reason, by: r.by });
  }

  private close(id: string, r: ChoiceResult): boolean {
    const p = this.pendingMap.get(id);
    if (!p) return false;
    this.pendingMap.delete(id);
    clearTimeout(p.timer);
    p.cleanup?.();
    p.resolve(r);
    this.record(p.req, r);
    this.bus.emit("choice.closed", { id, reason: r.reason, ...(r.picked !== undefined ? { picked: r.picked } : {}), ...(r.by ? { by: r.by } : {}) });
    return true;
  }
}
