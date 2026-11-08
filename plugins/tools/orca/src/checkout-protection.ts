// État de sûreté partagé : aucune consigne ni identité brute ne quitte la mémoire.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { corruptFiles, readJsonFile, writeJsonAtomic, type Context } from "@floppy/core";
import type { Hit, OrcaCli, OrcaRunner, OrcaTerminal, OrcaWorktree } from "./index.ts";
import { incarnation, permissionMenu, turnEndEvidence, type Receipt } from "./send-support.ts";
import { isWorker } from "./speech.ts";

const hash = (v: string): string => createHash("sha256").update(v).digest("hex");
const MAX = 800;
export interface ProtectionIdentity { checkout: string; agent: string; terminal: string }
interface Lock extends ProtectionIdentity {
  operation: string; sentAt: number; baselineEnd?: number;
  settled: boolean; receiptStarted: boolean; observedWorking: boolean; allowTransition: boolean;
  baselineIdleAt?: number; workingStartedAt?: number; lastStateAt?: number;
  initiallyWorking?: boolean; oldTurnEndedAt?: number;
}
export interface ProtectionSample { operations: ReadonlyMap<string, { operation: string; agent: string }>; order: number; at: number }
export interface ProtectedObservation { hit: Hit; sample: ProtectionSample }
const stateTime = (a: Hit["a"]): number | undefined => {
  const at = a.mainAgent?.stateStartedAt ?? a.stateStartedAt;
  return typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : undefined;
};
function agentIdentity(h: Hit): Omit<ProtectionIdentity, "terminal"> {
  const w = h.w as unknown as Record<string, unknown>;
  let path = String(w.checkoutPath || w.worktreePath || w.path || h.w.worktreeId.split("::").slice(1).join("::") || h.w.worktreeId);
  try { path = realpathSync.native(path); } catch { /* Dossier distant ou simulé. */ }
  path = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(path)) path = path.toLowerCase();
  return { checkout: hash(path), agent: hash(JSON.stringify([h.w.worktreeId, h.a.paneKey, incarnation(h.a)])) };
}
export interface ProtectionStorage { read(file: string): unknown; write(file: string, value: unknown): void }
export interface ProtectionOptions { storage?: ProtectionStorage; now?: () => number }
export function protectionIdentity(h: Hit, t: OrcaTerminal): ProtectionIdentity {
  return { ...agentIdentity(h), terminal: hash(JSON.stringify([t.handle, incarnation(t)])) };
}
function valid(value: unknown): value is { version: 1; blocked: boolean; locks: Lock[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["version", "blocked", "locks"].includes(k)) || v.version !== 1 || typeof v.blocked !== "boolean" || !Array.isArray(v.locks) || v.locks.length > MAX) return false;
  const keys = new Set<string>();
  return v.locks.every((r: Record<string, unknown>) => {
    if (!r || typeof r !== "object" || Object.keys(r).some(k => !["checkout", "agent", "terminal", "operation", "sentAt", "baselineEnd", "settled", "receiptStarted", "observedWorking", "allowTransition", "baselineIdleAt", "workingStartedAt", "lastStateAt", "initiallyWorking", "oldTurnEndedAt"].includes(k))) return false;
    if (![r.checkout, r.agent, r.terminal, r.operation].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) return false;
    if (typeof r.sentAt !== "number" || !Number.isFinite(r.sentAt) || r.sentAt < 0 || (r.baselineEnd !== undefined && (typeof r.baselineEnd !== "number" || !Number.isFinite(r.baselineEnd) || r.baselineEnd < 0))) return false;
    if (![r.baselineIdleAt, r.workingStartedAt, r.lastStateAt, r.oldTurnEndedAt].every(at => at === undefined || typeof at === "number" && Number.isFinite(at) && at >= 0)) return false;
    if (typeof r.baselineIdleAt === "number" && r.baselineIdleAt > r.sentAt || typeof r.lastStateAt === "number" && r.lastStateAt <= r.sentAt) return false;
    if (typeof r.workingStartedAt === "number" && (r.observedWorking !== true || r.workingStartedAt <= r.sentAt || typeof r.lastStateAt !== "number" || r.lastStateAt < r.workingStartedAt)) return false;
    if (r.initiallyWorking !== undefined && typeof r.initiallyWorking !== "boolean") return false;
    if (r.initiallyWorking === true && r.baselineIdleAt !== undefined) return false;
    if (r.oldTurnEndedAt !== undefined && (r.initiallyWorking !== true || typeof r.oldTurnEndedAt !== "number" || r.oldTurnEndedAt <= r.sentAt || typeof r.lastStateAt !== "number" || r.oldTurnEndedAt > r.lastStateAt)) return false;
    if (r.initiallyWorking === true && r.observedWorking === true && (typeof r.oldTurnEndedAt !== "number" || typeof r.workingStartedAt !== "number" || r.workingStartedAt <= r.oldTurnEndedAt)) return false;
    if (![r.settled, r.receiptStarted, r.observedWorking, r.allowTransition].every(b => typeof b === "boolean") || (r.observedWorking && !r.allowTransition) || (r.receiptStarted && !r.settled)) return false;
    if (keys.has(r.checkout as string)) return false;
    keys.add(r.checkout as string); return true;
  });
}

export class CheckoutProtection {
  private locks = new Map<string, Lock>();
  private blocked = false;
  private stopped = false;
  private listeners = new Set<(checkout: string, reason: string, state?: string) => void>();
  private file: string;
  private storage: ProtectionStorage;
  private now: () => number;
  private ctx: Context;
  private contexts = new Set<Context>();
  private sampleOrder = 0;
  private observedOrder = new Map<string, number>();
  constructor(ctx: Context, options: ProtectionOptions = {}) {
    this.ctx = ctx;
    this.file = join(ctx.home, "orca-checkout-protection.json");
    this.storage = options.storage ?? { read: readJsonFile, write: writeJsonAtomic };
    this.now = options.now ?? Date.now;
    try {
      const existed = existsSync(this.file);
      const before = corruptFiles().length;
      const value = this.storage.read(this.file);
      const damaged = corruptFiles().slice(before).some(r => r.file === this.file);
      // readJsonFile met le JSON corrompu de côté : son absence au démarrage suivant n'est pas un déverrouillage.
      const backup = value === undefined && existsSync(dirname(this.file)) && readdirSync(dirname(this.file)).some(n => n.startsWith(`${basename(this.file)}.corrupt-`));
      if (damaged || backup || (value === undefined && existed) || (value !== undefined && !valid(value))) this.problem("invalid-state");
      else if (valid(value)) {
        this.blocked = value.blocked;
        this.locks = new Map(value.locks.map(r => {
          // Les anciens fichiers ont perdu le départ « déjà working » après une simple reprise.
          // Sans repos initial daté, ne pas restaurer ce working ambigu comme preuve du nouveau tour.
          const restored = r.initiallyWorking !== undefined ? { ...r } : r.baselineIdleAt !== undefined ? { ...r, initiallyWorking: false } : { ...r, initiallyWorking: true, observedWorking: false, workingStartedAt: undefined, allowTransition: false };
          return [r.checkout, restored];
        }));
        if (!this.blocked && value.locks.some(r => r.initiallyWorking === undefined)) this.save(this.locks);
      }
      else if (existsSync(join(ctx.home, "orca-deliveries.json"))) this.problem("legacy-state-without-protection");
      if (this.blocked) this.storage.write(this.file, { version: 1, blocked: true, locks: [...this.locks.values()] });
      else if (value === undefined) this.save(new Map());
    } catch { this.problem("read-failed"); }
  }
  retain(ctx: Context, onEmpty: () => void): void {
    if (this.contexts.has(ctx)) return;
    this.contexts.add(ctx);
    ctx.effect(() => {
      this.contexts.delete(ctx);
      if (!this.contexts.size) { this.stopped = true; this.listeners.clear(); onEmpty(); }
    });
  }
  private problem(reason: string): void {
    if (!this.blocked) this.ctx.audit.write({ kind: "orca.delivery.protection", reason, at: this.now() });
    this.blocked = true;
  }
  private save(next: Map<string, Lock>): boolean {
    if (this.blocked || this.stopped) return false;
    try { this.storage.write(this.file, { version: 1, blocked: false, locks: [...next.values()] }); this.locks = next; return true; }
    catch { this.problem("write-failed"); return false; }
  }
  available(): boolean { return !this.blocked && !this.stopped; }
  waiting(checkout: string): boolean { return !this.available() || this.locks.has(checkout); }
  failure(checkout: string): "protection-unavailable" | "checkout-unconfirmed" | "protection-capacity" {
    return !this.available() ? "protection-unavailable" : this.locks.has(checkout) ? "checkout-unconfirmed" : "protection-capacity";
  }
  onRelease(listener: (checkout: string, reason: string, state?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  acquire(identity: ProtectionIdentity, operation: string, baselineEnd: number | undefined, initiallyWorking: boolean, initial?: Hit["a"]): string | undefined {
    if (!this.available() || this.locks.has(identity.checkout) || this.locks.size >= MAX) return undefined;
    const token = hash(operation);
    const next = new Map(this.locks);
    const sentAt = this.now();
    const idleAt = initial && /^(done|completed|idle)$/i.test(initial.mainAgent?.state ?? initial.state ?? "") ? stateTime(initial) : undefined;
    const baselineIdleAt = idleAt !== undefined && idleAt <= sentAt ? idleAt : undefined;
    next.set(identity.checkout, { ...identity, operation: token, sentAt, baselineEnd, baselineIdleAt, initiallyWorking, settled: false, receiptStarted: false, observedWorking: false, allowTransition: !initiallyWorking });
    return this.save(next) ? token : undefined;
  }
  private release(lock: Lock, reason: string, state?: string): boolean {
    if (this.locks.get(lock.checkout) !== lock) return false;
    const next = new Map(this.locks); next.delete(lock.checkout);
    if (!this.save(next)) return false;
    this.observedOrder.delete(lock.operation);
    this.ctx.audit.write({ kind: "orca.delivery.lock-release", checkoutHash: lock.checkout, agentHash: lock.agent, operationHash: lock.operation, reason, at: this.now(), elapsedMs: this.now() - lock.sentAt });
    for (const listener of this.listeners) { try { listener(lock.checkout, reason, state); } catch { /* Aucun observateur ne relance un envoi. */ } }
    return true;
  }
  receipt(checkout: string, operation: string, receipt?: Receipt): void {
    const lock = this.locks.get(checkout);
    if (!lock || lock.operation !== operation || !this.available()) return;
    if (receipt?.stage === "refused") { this.release(lock, "transport-refused"); return; }
    const next = new Map(this.locks);
    next.set(checkout, { ...lock, settled: true, receiptStarted: receipt?.stage === "turn_started" && !!receipt.requestId });
    this.save(next);
  }
  observe(h: Hit, t: OrcaTerminal, operation: string, sample?: ProtectionSample): boolean {
    const identity = protectionIdentity(h, t);
    const lock = this.locks.get(identity.checkout);
    if (!lock || lock.operation !== operation || !lock.settled || !this.available() || lock.agent !== identity.agent || lock.terminal !== identity.terminal || permissionMenu(h.a) || isWorker(h.a)) return false;
    const state = h.a.mainAgent?.state ?? h.a.state;
    const at = stateTime(h.a);
    if (sample && (sample.order < (this.observedOrder.get(operation) ?? 0) || at === undefined || at > sample.at)) return false;
    if (at !== undefined && (at <= lock.sentAt || at < (lock.lastStateAt ?? 0))) return false;
    if (sample) this.observedOrder.set(operation, sample.order);
    const rememberState = (): false => {
      if (at !== undefined && at !== lock.lastStateAt) { const next = new Map(this.locks); next.set(lock.checkout, { ...lock, lastStateAt: at }); this.save(next); }
      return false;
    };
    if (state === "working") {
      // Reprendre après waiting/permission appartient encore à l'ancien tour. Il faut d'abord sa fin.
      if (lock.initiallyWorking && (lock.oldTurnEndedAt === undefined || at === undefined || at <= lock.oldTurnEndedAt)) return rememberState();
      if (at !== undefined && at === lock.lastStateAt && !lock.observedWorking) return false;
      if ((at !== undefined || lock.allowTransition) && (!lock.observedWorking || at !== undefined && at !== lock.workingStartedAt)) {
        const next = new Map(this.locks); next.set(lock.checkout, { ...lock, observedWorking: true, allowTransition: true, workingStartedAt: at, lastStateAt: at }); this.save(next);
      }
      return false;
    }
    if (!/^(done|completed|idle)$/i.test(state ?? "")) return rememberState();
    if (lock.initiallyWorking && lock.oldTurnEndedAt === undefined) {
      if (at !== undefined) { const next = new Map(this.locks); next.set(lock.checkout, { ...lock, oldTurnEndedAt: at, lastStateAt: at }); this.save(next); }
      return false;
    }
    if (lock.initiallyWorking && !lock.observedWorking) return rememberState();
    if (lock.workingStartedAt !== undefined && (at === undefined || at <= lock.workingStartedAt)) return false;
    const end = turnEndEvidence(h.a);
    const attributable = lock.receiptStarted && end.identified && end.at !== undefined && end.at > lock.sentAt && end.at > (lock.baselineEnd ?? 0);
    // Le début de done est une fin, pas un début de travail. Ce raccourci exige donc un départ au repos
    // daté et un reçu durable de démarrage ; input_accepted seul ne suffit jamais.
    const shortCycle = lock.receiptStarted && lock.baselineIdleAt !== undefined && at !== undefined && at > lock.baselineIdleAt && at > lock.sentAt;
    if (!lock.observedWorking && !attributable && !shortCycle) return rememberState();
    return this.release(lock, lock.observedWorking ? "observed-working-to-idle" : shortCycle ? "started-idle-cycle-ended" : "attributable-turn-end", state);
  }
  capture(checkouts?: Set<string>): ProtectionSample {
    return { operations: new Map([...this.locks].filter(([checkout, lock]) => lock.settled && (!checkouts || checkouts.has(checkout))).map(([checkout, lock]) => [checkout, { operation: lock.operation, agent: lock.agent }])), order: ++this.sampleOrder, at: this.now() };
  }
  protectedOperation(h: Hit, sample: ProtectionSample): string | undefined {
    const identity = agentIdentity(h);
    const expected = sample.operations.get(identity.checkout);
    const lock = this.locks.get(identity.checkout);
    return expected?.agent === identity.agent && lock?.operation === expected.operation && lock.settled ? expected.operation : undefined;
  }
  async collect(rows: OrcaWorktree[], cli: OrcaCli, sample: ProtectionSample, pushed: ProtectedObservation[] = [], current: () => boolean = () => true): Promise<boolean> {
    if (!this.available()) return false;
    const hits = rows.flatMap(w => (w.agents ?? []).map(a => ({ w, a })));
    const live = new Set(hits.map(h => JSON.stringify(agentIdentity(h))));
    const candidates = [...pushed.filter(o => live.has(JSON.stringify(agentIdentity(o.hit)))), ...hits.map(hit => ({ hit, sample }))].filter(o => this.protectedOperation(o.hit, o.sample));
    if (!candidates.length) return true;
    try {
      const result = await cli(["terminal", "list"]) as { terminals?: OrcaTerminal[] } | undefined;
      if (!current() || !this.available()) return false;
      for (const o of candidates.sort((a, b) => a.sample.order - b.sample.order)) {
        const ts = result?.terminals?.filter(t => t.worktreeId === o.hit.w.worktreeId && `${t.tabId}:${t.leafId}` === o.hit.a.paneKey && /^term_[A-Za-z0-9-]{1,80}$/.test(t.handle));
        if (ts?.length === 1) this.observe(o.hit, ts[0]!, this.protectedOperation(o.hit, o.sample)!, o.sample);
      }
      return true;
    } catch { return false; /* Une observation manquante ne libère rien. */ }
  }
  async reconcile(checkouts: Set<string>, cli: OrcaCli, run: OrcaRunner): Promise<void> {
    // Une observation commencée pour l'ancien envoi ne prouve rien sur son successeur.
    const expected = new Map([...this.locks].filter(([checkout, lock]) => checkouts.has(checkout) && lock.settled).map(([checkout, lock]) => [checkout, lock.operation]));
    if (!this.available() || !expected.size) return;
    try {
      const rows = await run();
      if (![...expected].some(([checkout, operation]) => this.locks.get(checkout)?.operation === operation)) return;
      const result = await cli(["terminal", "list"]) as { terminals?: OrcaTerminal[] } | undefined;
      for (const w of rows) for (const a of w.agents ?? []) {
        const ts = result?.terminals?.filter(t => t.worktreeId === w.worktreeId && `${t.tabId}:${t.leafId}` === a.paneKey && /^term_[A-Za-z0-9-]{1,80}$/.test(t.handle));
        if (ts?.length !== 1) continue;
        const h = { w, a };
        const operation = expected.get(protectionIdentity(h, ts[0]!).checkout);
        if (operation) this.observe(h, ts[0]!, operation);
      }
    } catch { /* Une observation manquante ne libère rien. */ }
  }
}
const shared = new WeakMap<Context, CheckoutProtection>();
// Plusieurs instances du plugin dans le même dossier de travail ne créent pas de voie de contournement.
const homes = new Map<string, CheckoutProtection>();
export function checkoutProtection(ctx: Context, options?: ProtectionOptions): CheckoutProtection {
  let guard = shared.get(ctx);
  if (!guard) {
    let home = ctx.home;
    try { home = realpathSync.native(home); } catch { /* Le dossier peut ne pas exister au premier appel. */ }
    home = home.replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[A-Za-z]:\//.test(home)) home = home.toLowerCase();
    guard = homes.get(home);
    if (!guard) { guard = new CheckoutProtection(ctx, options); homes.set(home, guard); }
    const current = guard;
    guard.retain(ctx, () => { if (homes.get(home) === current) homes.delete(home); });
    shared.set(ctx, guard);
  }
  return guard;
}
