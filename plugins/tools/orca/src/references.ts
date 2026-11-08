/** Références de conversation : seules une présentation ou une discussion explicite les modifient. */
export interface AgentReference {
  identity: string;
  label: string;
  project: string;
  aliases?: readonly string[];
}

export type ReferenceMode = "focus" | "group" | "ordinal" | "name";
export type ReferenceFailure = "ambiguous" | "expired" | "missing" | "notfound" | "no_context" | "cardinality";
export interface ReferenceRequest { target?: string; cardinality?: "one" | "many" }
export type ReferenceResult<T extends AgentReference> = {
  mode: ReferenceMode;
  contextAgeMs: number | null;
} & ({ ok: true; references: T[] } | { ok: false; reason: ReferenceFailure; candidates: AgentReference[] });
export interface ReferenceDiagnostic {
  mode: ReferenceMode;
  selectedIds: string[];
  matchCount: number;
  contextAgeMs: number | null;
  reason?: ReferenceFailure;
}
export interface ReferenceOptions {
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
  maxReferences?: number;
  diagnostic?: (event: ReferenceDiagnostic) => void;
}

interface Context { group: AgentReference[]; focused?: AgentReference; touched: number; announcementKey?: string }
const words = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const compact = (s: string): string => words(s).replace(/ /g, "");
const FILLER = new Set(["agent", "agents", "projet", "project", "celui", "celle", "ceux", "celles", "the", "one", "on", "about", "sur", "dans", "pour", "avec", "les", "le", "la", "des", "du", "de", "l", "of", "task", "tache"]);

// Même tolérance que nameScore : espaces/tirets ignorés, puis un quart des lettres au plus.
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + Number(a[i - 1] !== b[j - 1]));
    prev = row;
  }
  return prev[b.length]!;
}
function score(ref: AgentReference, query: string): number | undefined {
  const q = compact(query);
  if (!q) return undefined;
  const fields = [ref.label, ref.project, ...(ref.aliases ?? [])];
  if (fields.some((f) => compact(f) === q)) return 0;
  if (fields.some((f) => compact(f).includes(q))) return 1;
  const qw = words(query).split(" ").filter((w) => w.length >= 3 && !FILLER.has(w));
  const fw = fields.flatMap((f) => words(f).split(" "));
  if (qw.length && qw.every((w) => fw.includes(w))) return 1;
  const close = (a: string, b: string): boolean => a.length >= 4 && b.length >= 4 && distance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4));
  if (fields.some((f) => close(compact(f), q)) || (qw.length && qw.every((w) => fw.some((f) => close(w, f))))) return 2;
  return undefined;
}

function ordinal(query: string): number | undefined {
  const q = words(query).replace(/^(le|la|the|celui|celle) /, "");
  const named: Record<string, number> = { premier: 1, premiere: 1, first: 1, deuxieme: 2, second: 2, seconde: 2, third: 3, troisieme: 3, fourth: 4, quatrieme: 4, fifth: 5, cinquieme: 5 };
  if (named[q]) return named[q];
  const match = /^(\d{1,3})(?:st|nd|rd|th|er|ere|e|eme)?$/.exec(q);
  return match ? Number(match[1]) : undefined;
}
const SINGULAR = new Set(["", "lui", "il", "elle", "celui ci", "celle ci", "cet agent", "this agent", "that agent", "him", "her", "it", "he", "she"]);
const PLURAL = new Set(["eux", "elles", "ils", "ceux ci", "celles ci", "tous", "toutes", "les agents", "them", "they", "all", "these agents", "those agents"]);

export function createAgentReferences(options: ReferenceOptions = {}) {
  const now = options.now ?? Date.now;
  const positive = (value: number, ceiling: number): number => {
    if (!Number.isFinite(value) || value < 1) throw new RangeError("Invalid reference limit");
    return Math.min(Math.floor(value), ceiling);
  };
  const ttl = positive(options.ttlMs ?? 30 * 60_000, 24 * 60 * 60_000);
  const capacity = positive(options.maxSessions ?? 64, 1024);
  const maxRefs = positive(options.maxReferences ?? 64, 256);
  const contexts = new Map<string, Context>();
  const snapshot = (ref: AgentReference): AgentReference => {
    if (!ref.identity || ref.identity.length > 256) throw new RangeError("Invalid reference identity");
    return { identity: ref.identity, label: ref.label.slice(0, 512), project: ref.project.slice(0, 256), aliases: ref.aliases?.slice(0, 16).map((a) => a.slice(0, 256)) };
  };
  function store(origin: string, ctx: Context): void {
    if (!origin || origin.length > 512) throw new RangeError("Invalid reference origin");
    contexts.delete(origin);
    contexts.set(origin, ctx);
    while (contexts.size > capacity) contexts.delete(contexts.keys().next().value!);
  }
  function focus(origin: string, ref: AgentReference): void {
    const saved = snapshot(ref);
    const old = contexts.get(origin);
    const fresh = old && now() - old.touched < ttl;
    store(origin, { group: fresh ? old.group : [saved], focused: saved, touched: now() });
  }
  return {
    /** Ordre réellement présenté, indépendant du tri des prochains relevés d'activité. */
    rememberPresented(origin: string, references: readonly AgentReference[], announcementKey?: string): void {
      if (references.length > maxRefs) throw new RangeError("Too many presented references");
      const group = [...new Map(references.map((ref) => [ref.identity, snapshot(ref)])).values()];
      store(origin, { group, focused: group.length === 1 ? group[0] : undefined, touched: now(), announcementKey });
    },
    revokeAnnouncement(origin: string, key: string): void {
      if (contexts.get(origin)?.announcementKey === key) contexts.delete(origin);
    },
    focus,
    clear(origin?: string): void { if (origin === undefined) contexts.clear(); else contexts.delete(origin); },
    /** Un succès singulier conserve le focus ; les échecs ne choisissent jamais un remplaçant. */
    resolve<T extends AgentReference>(origin: string, live: readonly T[], request: ReferenceRequest = {}): ReferenceResult<T> {
      const ctx = contexts.get(origin);
      const age = ctx ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now() - ctx.touched)) : null;
      const query = words((request.target ?? "").slice(0, 512));
      const nth = ordinal(query);
      const plural = PLURAL.has(query) || (query === "" && request.cardinality === "many");
      const mode: ReferenceMode = nth !== undefined ? "ordinal" : plural ? "group" : SINGULAR.has(query) ? "focus" : "name";
      const finish = (result: ReferenceResult<T>, matchCount: number): ReferenceResult<T> => {
        const event: ReferenceDiagnostic = { mode, selectedIds: result.ok ? result.references.slice(0, maxRefs).map((r) => r.identity.slice(0, 256)) : [], matchCount, contextAgeMs: age, ...(!result.ok ? { reason: result.reason } : {}) };
        // Une panne du journal ne change pas le résultat ni la cible.
        try { options.diagnostic?.(event); } catch { /* Le diagnostic est facultatif. */ }
        return result;
      };
      const fail = (reason: ReferenceFailure, candidates: readonly AgentReference[] = []): ReferenceResult<T> => finish({ ok: false, reason, candidates: candidates.slice(0, maxRefs).map(snapshot), mode, contextAgeMs: age }, candidates.length);
      let selected: readonly AgentReference[];
      if (mode === "name") {
        // Les anciennes étiquettes restent attachées à leur identité, même après une disparition.
        const pool = [...live, ...(ctx && age! < ttl ? [...ctx.group, ...(ctx.focused ? [ctx.focused] : [])] : [])];
        const byIdentity = new Map<string, { ref: AgentReference; rank: number }>();
        for (const ref of pool) {
          const rank = score(ref, query);
          if (rank !== undefined && rank < (byIdentity.get(ref.identity)?.rank ?? Infinity)) byIdentity.set(ref.identity, { ref, rank });
        }
        const ranked = [...byIdentity.values()];
        const best = Math.min(...ranked.map((x) => x.rank!));
        selected = ranked.filter((x) => x.rank === best).map((x) => x.ref);
        if (!selected.length) return fail("notfound");
      } else {
        if (!ctx) return fail("no_context");
        if (age! >= ttl) return fail("expired");
        if (mode === "ordinal") selected = ctx.group[nth! - 1] ? [ctx.group[nth! - 1]!] : [];
        else if (mode === "group") selected = ctx.group;
        else selected = ctx.focused ? [ctx.focused] : ctx.group;
        if (!selected.length) return fail("notfound");
      }
      const many = request.cardinality === "many" || (request.cardinality === undefined && plural);
      if (!many && selected.length !== 1) return fail("ambiguous", selected);
      if (request.cardinality === "one" && plural) return fail("cardinality", selected);
      if (selected.length > maxRefs) return fail("cardinality", selected);
      const current = new Map(live.map((ref) => [ref.identity, ref]));
      const missing = selected.filter((ref) => !current.has(ref.identity));
      if (missing.length) return fail("missing", missing);
      const references = selected.map((ref) => current.get(ref.identity)!);
      if (!many) focus(origin, references[0]!);
      return finish({ ok: true, references, mode, contextAgeMs: age }, references.length);
    },
  };
}
