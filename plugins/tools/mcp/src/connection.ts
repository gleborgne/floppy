// Une connexion = un connecteur ouvert : serveur MCP (stdio ou HTTP) ou commande transformée en outil.
// Ouvrir, fermer et filtrer les outils se font à chaud, pour un seul connecteur à la fois.
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorText, T, TextError, tr, type Context, type Level, type Rule, type Text, type ToolDef, type ToolResult } from "@floppy/core";
import { resolveLevel, type LevelSetting } from "./levels.ts";
import { azTokenProvider, bearerFetch } from "./azcli.ts";

/** Ce qu'un connecteur est, une fois les valeurs de la config et de l'utilisateur fusionnées. */
export interface Spec {
  kind: "mcp-local" | "mcp-remote" | "command";
  label?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  auth?: { type: "azcli"; resource: string } | { type: "token" };
  cloud: boolean;
  levels: Record<string, LevelSetting>;
  include?: string[];
  exclude: string[];
  /** Nom de la variable d'environnement dont la valeur est un secret (rangée dans ctx.secrets). */
  secretEnvName?: string;
  /** Note pour le cerveau, ajoutée à la description de chaque outil (ex. comment faire l'adresse web d'une PR). */
  note?: string;
  // Type « commande »
  description?: string;
  level?: Level;
  timeoutS?: number;
}

export interface RawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  level: Level;
  rule?: Rule;
}

export interface Opened {
  tools: RawTool[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}

export const secretName = (id: string, what: "env" | "token"): string => `tools/${id}/${what}`;

/** Message d'une erreur : bilingue quand c'est une TextError. */
export function errText(e: unknown): Text {
  return errorText(e);
}

/** Texte bilingue construit autour d'un autre texte (ex. une erreur). */
export function wrap(inner: Text, fr: (s: string) => string, en: (s: string) => string): Text {
  return T(fr(tr(inner, "fr")), en(tr(inner, "en")));
}

const MAX_OUT = 4000;

/** Nom d'outil valable pour un modèle : lettres, chiffres, soulignés. */
export function toolNameOf(label: string): string {
  return label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "commande";
}

export function clipOut(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n[sortie tronquée]" : t;
}

/** Erreur (en français, pour le modèle) si `texte` remplirait tout un argument en commençant par « - » : injection d'option. */
export function texteError(args: string[], texte: string): string | undefined {
  if (args.includes("{texte}") && texte.trimStart().startsWith("-")) {
    return "Le texte ne doit pas commencer par « - » (il serait pris pour une option de la commande). Reformule sans tiret au début.";
  }
  return undefined;
}

/** Remplace `{texte}` dans chaque argument (sans shell : pas d'injection possible). */
export function fillArgs(args: string[], texte: string): string[] {
  return args.map((a) => a.split("{texte}").join(texte));
}

function commandTool(spec: Spec, id: string): { tool: RawTool; run: Opened["call"] } {
  const name = toolNameOf(spec.label ?? id);
  const takesText = spec.args.some((a) => a.includes("{texte}"));
  const timeout = Math.max(1, spec.timeoutS ?? 30) * 1000;
  const tool: RawTool = {
    name,
    description: spec.description || `Lance la commande ${spec.command}.`,
    inputSchema: takesText
      ? { type: "object", properties: { texte: { type: "string", description: "Texte donné à la commande." } }, required: ["texte"] }
      : { type: "object", properties: {} },
    level: spec.level ?? "write", // sans choix explicite : avec accord
  };
  const run: Opened["call"] = (_n, args, signal) => new Promise<ToolResult>((ok) => {
    const texte = typeof args.texte === "string" ? args.texte : "";
    const bad = texteError(spec.args, texte);
    if (bad) return ok({ status: "failed", text: bad });
    execFile(spec.command!, fillArgs(spec.args, texte), {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false,
      ...(spec.cwd ? { cwd: spec.cwd } : {}), ...(signal ? { signal } : {}), encoding: "utf8",
    }, (err, stdout, stderr) => {
      const out = clipOut(`${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`);
      if (!err) return ok({ status: "done", text: out || "(pas de sortie)" });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed) return ok({ status: "failed", text: `Délai dépassé (${timeout / 1000} s).${out ? `\n${out}` : ""}` });
      ok({ status: "failed", text: out || `La commande a échoué : ${e.message}` });
    });
  });
  return { tool, run };
}

function makeTransport(spec: Spec, secret: string | undefined, onStderr: (s: string) => void): Transport {
  if (spec.url) {
    const fetch = spec.auth?.type === "azcli" ? bearerFetch(azTokenProvider(spec.auth.resource)) : undefined;
    const headers = { ...spec.headers, ...(spec.auth?.type === "token" && secret ? { Authorization: `Bearer ${secret}` } : {}) };
    return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers }, ...(fetch ? { fetch } : {}) });
  }
  const t = new StdioClientTransport({
    command: spec.command!,
    args: spec.args,
    env: { ...getDefaultEnvironment(), PYTHONUTF8: "1", ...spec.env, ...(spec.secretEnvName && secret ? { [spec.secretEnvName]: secret } : {}) },
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    stderr: "pipe",
  });
  t.stderr?.on("data", (d: Buffer) => onStderr(d.toString()));
  return t;
}

/** Délai pour se connecter et lister les outils d'un serveur MCP. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Ouvre un connecteur (sans rien enregistrer dans le registre d'outils). */
export async function open(
  id: string, spec: Spec, secret: string | undefined,
  hooks: { onStderr?: (s: string) => void; onClose?: () => void; timeoutMs?: number } = {},
): Promise<Opened> {
  if (spec.kind === "command") {
    if (!spec.command) throw new TextError(T("commande manquante", "missing command"));
    const { tool, run } = commandTool(spec, id);
    return { tools: [tool], call: run, close: async () => {} };
  }
  if (spec.auth?.type === "token" && !secret) throw new TextError(T("jeton manquant", "missing token"));
  const c = new Client({ name: "floppy", version: "0.1.0" });
  let closing = false;
  const transport = makeTransport(spec, secret, hooks.onStderr ?? (() => {}));
  c.onclose = () => { if (!closing) hooks.onClose?.(); };
  const ms = hooks.timeoutMs ?? CONNECT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Un serveur qui ne répond pas ne doit pas bloquer : délai, puis le processus est fermé et ce connecteur seul tombe en erreur.
    const work = (async () => { await c.connect(transport); return c.listTools(); })();
    work.catch(() => {});
    const { tools } = await Promise.race([
      work,
      new Promise<never>((_, ko) => { timer = setTimeout(() => ko(new TextError(T(`pas de réponse après ${Math.round(ms / 1000)} s`, `no answer after ${Math.round(ms / 1000)} s`))), ms); }),
    ]);
    clearTimeout(timer);
    return {
      tools: tools.map((t) => {
        const { level, rule } = resolveLevel(t.name, spec.levels, t.annotations);
        return { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown>, level, ...(rule ? { rule } : {}) };
      }),
      call: async (name, args, signal) => {
        const r = await c.callTool({ name, arguments: args }, undefined, signal ? { signal } : {});
        const content = (r.content ?? []) as { type: string; text?: string }[];
        const text = content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
        return { status: r.isError ? "failed" : "done", text, raw: r.content };
      },
      close: async () => { closing = true; await c.close().catch(() => {}); },
    };
  } catch (e) {
    clearTimeout(timer);
    closing = true;
    await Promise.allSettled([c.close(), transport.close()]);
    throw e;
  }
}

export type State = "off" | "connecting" | "on" | "error";

export interface Connection {
  readonly id: string;
  state(): State;
  error(): Text;
  /** Tous les outils du serveur (avant filtre). */
  tools(): RawTool[];
  /** Nombre d'outils donnés au cerveau. */
  visibleCount(): number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Refait le filtre des outils sans rouvrir la connexion. */
  refilter(): void;
}

export function secretFor(ctx: Context, id: string, spec: Spec): string | undefined {
  if (spec.auth?.type === "token") return ctx.secrets.get(secretName(id, "token"));
  if (spec.secretEnvName) return ctx.secrets.get(secretName(id, "env"));
  return undefined;
}

/** Un connecteur de la liste. `spec()` et `visible()` sont relus à chaque fois : un changement s'applique à chaud. */
export function makeConnection(
  ctx: Context, id: string,
  get: { spec(): Spec; visible(name: string): boolean; onTools(tools: RawTool[]): void; onChange(): void },
): Connection {
  let state: State = "off";
  let error: Text = "";
  let opened: Opened | undefined;
  let raw: RawTool[] = [];
  let unregister: (() => void) | undefined;
  let visible = 0;
  let stderrTail = "";
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const drop = (): void => { unregister?.(); unregister = undefined; visible = 0; };

  const register = (): void => {
    unregister?.(); unregister = undefined;
    const o = opened;
    if (!o) return;
    const note = get.spec().note?.trim();
    const defs: ToolDef[] = raw.filter((t) => get.visible(t.name)).map((t) => ({
      name: t.name,
      description: note ? `${t.description}
Note : ${note}` : t.description,
      inputSchema: t.inputSchema,
      level: t.level,
      ...(t.rule ? { rule: t.rule } : {}),
      // Carte d'accord lisible : « Office 365 · ask : Combien de mails non lus… ? » (pas de JSON brut).
      summary: (args: Record<string, unknown>) => readableSummary(get.spec().label ?? id, t.name, args),
      handler: async (args, meta) => o.call(t.name, args, meta.signal),
    }));
    unregister = defs.length ? ctx.tools.register(defs) : undefined;
    visible = defs.length;
  };

  const doConnect = async (): Promise<void> => {
    if (state === "on") return;
    state = "connecting";
    error = "";
    stderrTail = "";
    get.onChange();
    try {
      const spec = get.spec();
      let o: Opened | undefined;
      o = await open(id, spec, secretFor(ctx, id, spec), {
        onStderr: (s) => { stderrTail = (stderrTail + s).slice(-2000); },
        onClose: () => {
          if (!o || opened !== o) return;
          // Arrêt inattendu : ce connecteur seul tombe en erreur, le reste continue.
          opened = undefined;
          drop();
          state = "error";
          const tail = stderrTail ? stderrTail.trim().split("\n").pop() : "";
          error = T(`le serveur s'est arrêté${tail ? ` : ${tail}` : ""}`, `the server stopped${tail ? `: ${tail}` : ""}`);
          ctx.log("error", `connecteur ${id} : ${tr(error)}`);
          ctx.audit.write({ kind: "mcp.server_down", server: id, error: tr(error) });
          get.onChange();
        },
      });
      opened = o;
      raw = o.tools;
      get.onTools(raw);
      register();
      state = "on";
      ctx.log("info", `connecteur ${id} : ${visible} outils sur ${raw.length}`, {
        read: raw.filter((d) => d.level === "read").length,
        never: raw.filter((d) => d.rule === "never").length,
      });
    } catch (e) {
      opened = undefined;
      drop();
      state = "error";
      error = errText(e);
      ctx.log("error", `connecteur ${id} : démarrage impossible : ${tr(error)}`);
      ctx.audit.write({ kind: "mcp.server_failed", server: id, error: tr(error) });
      get.onChange();
      throw e;
    }
    get.onChange();
  };

  const doDisconnect = async (): Promise<void> => {
    const o = opened;
    opened = undefined; // fait ignorer onClose
    drop();
    state = "off";
    error = "";
    if (o) await o.close();
    get.onChange();
  };

  return {
    id,
    state: () => state,
    error: () => error,
    tools: () => raw,
    visibleCount: () => visible,
    connect: () => serial(doConnect),
    disconnect: () => serial(doDisconnect),
    refilter: () => { if (state === "on") register(); },
  };
}

/** Résumé d'un appel pour la carte d'accord : connecteur, outil, et les valeurs en clair (sans accolades). */
export function readableSummary(label: string, tool: string, args: Record<string, unknown>): string {
  const vals = Object.values(args ?? {}).flatMap((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [String(v)] : []));
  const text = vals.join(" · ").replace(/\s+/g, " ").trim();
  const clipped = text.length > 160 ? text.slice(0, 157) + "…" : text;
  return clipped ? `${label} · ${tool} : ${clipped}` : `${label} · ${tool}`;
}
