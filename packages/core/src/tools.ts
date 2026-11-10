// Registre des outils du noyau. TOUT appel d'outil passe par call() :
//   hook tool.before → règle du niveau + accord → exécution → journal.
// Le même chemin protège tous les cerveaux (AI SDK en direct, CLI Claude/Codex par le serveur MCP Floppy).
import type { ApprovalManager } from "./approval.ts";
import type { Audit } from "./audit.ts";
import type { Hooks } from "./plugin/hooks.ts";
import type { Level, Rule } from "./config/schema.ts";
import { errorText, T, tr, type Text } from "./i18n.ts";
import { randomUUID } from "node:crypto";

export type JsonSchema = Record<string, unknown>;

export interface ToolCallMeta {
  /** Conversation d'origine, attachée par l'appelant hôte (jamais par les arguments du modèle). */
  session?: string;
  /** Tour hôte, partagé avec les observations de mémoire. */
  turn?: string;
  /** Identifiant neuf fixé par le registre pour chaque appel. */
  callId?: string;
  /** Qui appelle : "aisdk", "mcp", "cli"… */
  caller?: string;
  /** Corps d'origine du tour (routage de l'accord et des outils corps). */
  origin?: string;
  signal?: AbortSignal;
}

export type ToolStatus = "done" | "unverified" | "failed" | "refused";

export interface ToolResult {
  status: ToolStatus;
  /** Texte rendu au modèle. */
  text: string;
  /** Contenu brut (ex. contenu MCP) si besoin. */
  raw?: unknown;
}

/** Ce que rend un outil : le texte peut être { fr, en } (rendu au modèle dans la langue de l'assistant). */
export type ToolOutput = Omit<ToolResult, "text"> & { text: Text };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  level: Level;
  /** Règle propre à l'outil (ne peut que durcir la règle du niveau). */
  rule?: Rule | (() => Rule | undefined);
  /** Réduit les paramètres du journal aux métadonnées utiles. En sa présence, l'erreur brute est aussi masquée. */
  auditArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Phrase pour la demande d'accord (texte simple ou { fr, en }). Par défaut : nom + paramètres. */
  summary?: (args: Record<string, unknown>) => Text;
  handler: (args: Record<string, unknown>, meta: ToolCallMeta) => Promise<ToolOutput>;
  /** Réservé au noyau : l'outil fait lui-même son contrôle de risque (réglages). Retiré des outils des plugins. */
  selfApproved?: boolean;
  /** Outil lent (plus de 3 s) : phrase dite dès que le cerveau choisit l'outil (« Je cherche, une seconde. »). */
  waitPhrase?: Text;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  level: Level;
  source: string;
  /** Phrase d'attente, dans la langue de l'assistant. */
  waitPhrase?: string;
}

export interface ToolCallInput {
  name: string;
  args: Record<string, unknown>;
  meta: ToolCallMeta;
  tool: ToolInfo;
}

export const REFUSED_TEXT = "Refusé par l'utilisateur. L'action n'a pas été faite. Ne la retente pas.";
export const NEVER_TEXT = "Action interdite par la configuration. Elle n'a pas été faite. Ne la retente pas.";
/** Les mêmes, en français et en anglais (rendus dans la langue de l'assistant). */
const REFUSED = T(REFUSED_TEXT, "Refused by the user. The action was not done. Do not try again.");
const NEVER = T(NEVER_TEXT, "Action forbidden by the configuration. It was not done. Do not try again.");

export class ToolRegistry {
  private tools = new Map<string, { def: ToolDef; source: string }>();
  private listeners = new Set<() => void>();
  /** Outils cachés au cerveau par l'utilisateur (décochés dans la fenêtre des réglages). */
  private hidden = new Set<string>();
  private readonly approvals: ApprovalManager;
  private readonly audit: Audit;
  private readonly hooks: Hooks;
  /** Langue de l'assistant : textes rendus au modèle et phrases d'attente. Donnée par le noyau. */
  lang: () => string = () => "fr";

  constructor(approvals: ApprovalManager, audit: Audit, hooks: Hooks) {
    this.approvals = approvals;
    this.audit = audit;
    this.hooks = hooks;
  }

  /** Ajoute des outils. Un nom déjà pris est refusé (erreur). Retourne une fonction pour les retirer. */
  register(source: string, defs: ToolDef[]): () => void {
    for (const d of defs) {
      const cur = this.tools.get(d.name);
      if (cur) throw new Error(`outil ${d.name} déjà fourni par ${cur.source}`);
    }
    for (const d of defs) this.tools.set(d.name, { def: d, source });
    this.changed();
    return () => {
      let removed = false;
      for (const d of defs) {
        if (this.tools.get(d.name)?.def === d) { this.tools.delete(d.name); removed = true; }
      }
      if (removed) this.changed();
    };
  }

  /** Outils visibles par le cerveau. */
  list(): ToolInfo[] {
    return this.listAll().filter((t) => !this.hidden.has(t.name));
  }

  /** Tous les outils, cachés compris (pour la fenêtre des réglages). */
  listAll(): ToolInfo[] {
    return [...this.tools.values()].map(({ def, source }) => ({
      name: def.name, description: def.description, inputSchema: def.inputSchema, level: def.level, source,
      ...(def.waitPhrase ? { waitPhrase: tr(def.waitPhrase, this.lang()) } : {}),
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name) && !this.hidden.has(name);
  }

  setHidden(names: Iterable<string>): void {
    const next = new Set(names);
    if ([...next].sort().join() === [...this.hidden].sort().join()) return;
    this.hidden = next;
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async call(name: string, args: Record<string, unknown>, meta: ToolCallMeta = {}): Promise<ToolResult> {
    meta = { ...meta, callId: randomUUID() };
    const t0 = performance.now();
    const entry = this.hidden.has(name) ? undefined : this.tools.get(name);
    if (!entry) {
      this.audit.write({ kind: "tool", tool: name, args, status: "failed", error: "outil inconnu", caller: meta.caller, callId: meta.callId, session: meta.session, turn: meta.turn });
      return { status: "failed", text: tr(T(`Outil inconnu : ${name}`, `Unknown tool: ${name}`), this.lang()) };
    }
    const { def, source } = entry;
    const info: ToolInfo = { name, description: def.description, inputSchema: def.inputSchema, level: def.level, source };
    let result: ToolResult;
    try {
      meta.signal?.throwIfAborted();
      result = await this.hooks.run("tool.before", { name, args, meta, tool: info }, async (input): Promise<ToolResult> => {
        meta.signal?.throwIfAborted();
        const run = async (): Promise<ToolResult> => { const out = await def.handler(input.args, meta); return { ...out, text: tr(out.text, this.lang()) }; };
        if (def.selfApproved) return run();
        const decision = await this.approvals.check({
          tool: name, source, args: input.args, level: def.level,
          callId: meta.callId, session: meta.session, turn: meta.turn,
          summary: def.summary ? def.summary(input.args) : defaultSummary(name, input.args),
          override: typeof def.rule === "function" ? def.rule() : def.rule,
          ...(meta.origin ? { origin: meta.origin } : {}),
          signal: meta.signal,
        });
        if (!decision.ok) return { status: "refused", text: tr(decision.reason === "policy-never" ? NEVER : REFUSED, this.lang()) };
        meta.signal?.throwIfAborted();
        return run();
      });
    } catch (e) {
      const why = tr(errorText(e), this.lang());
      result = { status: "failed", text: tr(T(`Erreur de l'outil ${name} : ${why}`, `Tool ${name} failed: ${why}`), this.lang()) };
    }
    this.audit.write({
      kind: "tool", tool: name, source, level: def.level, args: auditArgs(def, args), status: result.status,
      callId: meta.callId, session: meta.session, turn: meta.turn,
      ms: Math.round(performance.now() - t0), caller: meta.caller, origin: meta.origin,
      ...(result.status === "failed" ? { error: def.auditArgs ? "tool-failed" : result.text.slice(0, 300) } : {}),
    });
    return result;
  }

  private changed(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* un abonné ne casse pas les autres */ }
    }
  }
}

function defaultSummary(name: string, args: Record<string, unknown>): string {
  const a = JSON.stringify(args);
  return `${name} ${a.length > 160 ? a.slice(0, 157) + "…" : a}`;
}

function auditArgs(def: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  if (!def.auditArgs) return args;
  try { return def.auditArgs(args); }
  catch { return { redacted: true }; } // Une erreur du filtre ne doit jamais exposer les paramètres d'origine.
}
