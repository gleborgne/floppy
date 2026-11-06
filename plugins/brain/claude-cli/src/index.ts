// Plugin `brain-claude-cli` : Claude Code (CLI officiel, déjà connecté par l'utilisateur) comme cerveau.
// - Service `delegate` (montage A : Gemma délègue les demandes difficiles) et/ou `brain` (montage B, sans GPU).
// - Le CLI n'a QUE le serveur MCP Floppy : mêmes outils, même accord, même journal que les autres cerveaux.
//   Ses outils intégrés (shell, fichiers, web…) sont coupés ; la liste réelle est vérifiée à chaque lancement.
// - On ne lit, ne copie ni ne stocke jamais les identifiants du CLI. On ne touche pas à sa config globale.
// Port de ClaudeBrain (prototypes/cli-brain/src/brains.ts). Options vérifiées au prototype 3 quater.
import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentPrompt, definePlugin, killTree, type BrainEvent, type BrainService, type CompletionService, type Context } from "@floppy/core";
import type { McpEndpoint } from "@floppy/core";

const Config = z.object({
  exe: z.string().default(process.env.CLAUDE_EXE ?? join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe")),
  /** Arguments ajoutés avant les autres (pour les tests : un script devant un faux CLI). */
  exeArgs: z.array(z.string()).default([]),
  /** Modèle par défaut du cerveau principal (et du montage B, `as: [brain]`). Changeable dans les réglages. */
  model: z.string().default("sonnet"),
  /** Modèle par défaut de la délégation (tâches complexes). Changeable dans les réglages. */
  delegateModel: z.string().default("opus"),
  /** Services fournis : « delegate » (défaut) et/ou « brain ». */
  as: z.array(z.enum(["delegate", "brain"])).default(["delegate"]),
  cwd: z.string().optional(),
  timeout_s: z.number().default(120),
  /**
   * Modèles proposés : chacun est un élément qu'on choisit comme cerveau principal, délégué ou pour les appels
   * ponctuels (tri, résumé). `id` = nom du modèle pour le CLI (alias « opus », « sonnet », « haiku » ou nom complet).
   */
  models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1).default([
    { id: "opus", label: "Claude Opus" },
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "haiku", label: "Claude Haiku" },
  ]),
  /** Ancien nom de `models` (appels ponctuels seulement) : ajouté à la liste s'il est donné. */
  completionModels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
});
type Config = z.infer<typeof Config>;

/** Prompt des cerveaux CLI (commun à Claude, Codex et Antigravity : il vit dans le noyau). */
export const cliPrompt = agentPrompt;

/** Environnement propre : pas de variables d'une session Claude parente ni d'Orca. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|COMPUTERNAME|LANG|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** Trouve le JSON dans une réponse (avec ou sans ```json, avec ou sans texte autour). */
export function extractJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(s); } catch { /* texte autour : on cherche plus loin */ }
  const a = s.search(/[{[]/);
  if (a < 0) throw new Error("réponse sans JSON");
  const close = s[a] === "{" ? "}" : "]";
  const b = s.lastIndexOf(close);
  if (b <= a) throw new Error("JSON incomplet");
  return JSON.parse(s.slice(a, b + 1));
}

/** Un appel ponctuel au CLI : aucun outil, aucun MCP, aucune mémoire. Le prompt passe par l'entrée standard. */
function makeCompletion(ctx: Context, cfg: Config, model: string, label: string): CompletionService {
  const cwd = cfg.cwd ?? join(ctx.home, "claude-workdir");
  const once = (system: string, prompt: string, signal?: AbortSignal): Promise<string> => new Promise((ok, ko) => {
    if (signal?.aborted) return ko(new Error("annulé"));
    mkdirSync(cwd, { recursive: true });
    const p = ctx.spawn(cfg.exe, [...cfg.exeArgs,
      "-p", "--output-format", "json", "--model", model,
      "--tools", "",                                          // aucun outil intégré
      "--permission-mode", "dontAsk",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', // aucun serveur MCP
      "--setting-sources", "project", "--disable-slash-commands", "--no-session-persistence",
      "--system-prompt", system,
    ], { cwd, windowsHide: true, env: cleanEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1" }) }) as ChildProcessWithoutNullStreams;
    let out = "", err = "", done = false;
    const end = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); f(); };
    const stop = () => { void killTree(p); };
    const onAbort = () => end(() => { stop(); ko(new Error("annulé")); });
    const timer = setTimeout(() => end(() => { stop(); ko(new Error("délai dépassé")); }), cfg.timeout_s * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.stdin.on("error", () => {});
    p.once("error", (e) => end(() => ko(e)));
    p.once("close", (code) => end(() => {
      if (code !== 0) return ko(new Error(`Claude s'est arrêté (code ${code}) : ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
      try {
        let j: any = JSON.parse(out);
        if (Array.isArray(j)) j = j.findLast((x) => x?.type === "result") ?? {};
        if (j.is_error) return ko(new Error(`Claude a répondu par une erreur : ${String(j.result ?? "").slice(0, 300)}`));
        ok(String(j.result ?? ""));
      } catch {
        ko(new Error("réponse illisible du CLI Claude"));
      }
    }));
    p.stdin.end(prompt);
  });
  return {
    label, cloud: true,
    async complete(req) {
      if (!req.schema) return { text: (await once(req.system, req.prompt, req.signal)).trim() };
      const system = `${req.system}\nRéponds seulement avec un JSON valide qui suit ce schéma : ${JSON.stringify(req.schema)}`;
      let last = "";
      for (let essai = 0; essai < 2; essai++) {
        last = await once(system, essai ? `${req.prompt}\n\n(Ta réponse précédente n'était pas du JSON valide. Réponds seulement avec le JSON.)` : req.prompt, req.signal);
        try { return { text: last.trim(), json: extractJson(last) }; } catch { /* un second essai */ }
      }
      throw new Error(`Claude n'a pas donné de JSON valide : ${last.trim().slice(0, 120)}`);
    },
  };
}

class LineQueue {
  private buf: unknown[] = [];
  private waiters: ((v: unknown) => void)[] = [];
  closed = false;
  constructor(stream: NodeJS.ReadableStream) {
    const rl = createInterface({ input: stream });
    rl.on("line", (l) => {
      let v: unknown;
      try { v = JSON.parse(l); } catch { return; }
      const w = this.waiters.shift();
      if (w) w(v); else this.buf.push(v);
    });
    rl.on("close", () => { this.closed = true; for (const w of this.waiters.splice(0)) w(null); });
  }
  next(): Promise<any> {
    if (this.buf.length) return Promise.resolve(this.buf.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((ok) => this.waiters.push(ok));
  }
}

type Proc = { p: ChildProcessWithoutNullStreams; q: LineQueue };

/** Modèle choisi, relu à chaque lancement d'un processus (le changer ne redémarre rien). */
type Pick = () => { id: string; label: string };
const labelOf = (id: string) => `Claude ${id.charAt(0).toUpperCase()}${id.slice(1)}`;

function makeBrain(ctx: Context, cfg: Config, mcp: McpEndpoint, pick: Pick = () => ({ id: cfg.model, label: labelOf(cfg.model) })): BrainService & { stop(): Promise<void>; renew(): void } {
  const cwd = cfg.cwd ?? join(ctx.home, "claude-workdir");
  mkdirSync(cwd, { recursive: true });
  const mcpConfig = JSON.stringify({ mcpServers: { floppy: { type: "http", url: mcp.url, headers: { Authorization: "Bearer ${FLOPPY_MCP_TOKEN}" } } } });
  // Les arguments (donc le prompt) suivent les outils visibles au moment du lancement.
  const buildArgs = () => [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", pick().id,
    "--tools", "",                                   // aucun outil intégré (Bash, Read, Edit, WebFetch, Task…)
    "--strict-mcp-config", "--mcp-config", mcpConfig, // seulement le serveur MCP Floppy
    "--allowedTools", "mcp__floppy",                 // nos outils passent sans question du CLI : l'accord est tenu par le noyau
    "--permission-mode", "dontAsk",                  // tout le reste est refusé sans question
    "--setting-sources", "project",                  // pas de réglages utilisateur (hooks, plugins…)
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", cliPrompt(ctx.assistant.name, ctx.tools.list(), ctx.assistant.language),
  ];
  let spare: Proc | undefined;
  const live = new Set<Proc>();
  const spawnProc = (): Proc => {
    const p = ctx.spawn(cfg.exe, [...cfg.exeArgs, ...buildArgs()], {
      cwd, windowsHide: true,
      env: cleanEnv({ FLOPPY_MCP_TOKEN: mcp.token, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1" }),
    }) as ChildProcessWithoutNullStreams;
    p.stderr.on("data", (d) => ctx.log("debug", `claude : ${String(d).slice(0, 300)}`));
    p.on("error", (e) => ctx.log("error", `claude : ${e.message}`));
    const proc = { p, q: new LineQueue(p.stdout) };
    live.add(proc);
    p.on("exit", () => {
      live.delete(proc);
      if (spare === proc) spare = undefined; // la réserve est morte : la demande suivante en relance une
    });
    return proc;
  };
  spare = spawnProc(); // réchauffé dès le démarrage : la 1re délégation n'est pas « à froid »
  /** La réserve a été lancée avec l'ancien prompt ou l'ancien modèle : on la relance. */
  const renew = () => {
    const old = spare;
    if (!old || !ctx.alive) return;
    spare = undefined;
    void killTree(old.p);
    spare = spawnProc();
  };
  // Outils ajoutés ou retirés : au démarrage ils arrivent un par un, on attend que ça se calme avant de relancer la réserve.
  let refresh: NodeJS.Timeout | undefined;
  ctx.tools.onChange(() => {
    clearTimeout(refresh);
    refresh = setTimeout(renew, 1000);
    refresh.unref?.();
  });
  return {
    get name() { return `claude:${pick().id}`; },
    get label() { return pick().label; },
    get aliases() { return ["claude", "claude code", pick().id, pick().label.toLowerCase(), "anthropic"]; },
    renew,
    reset: () => {},
    async *run(input) {
      const proc = spare ?? spawnProc();
      spare = undefined;
      const kill = () => { void killTree(proc.p); };
      input.signal?.addEventListener("abort", kill, { once: true });
      const t0 = Date.now();
      let timedOut = false, tools = 0;
      const timer = setTimeout(() => { timedOut = true; ctx.log("warn", `claude : délai de ${cfg.timeout_s} s dépassé, processus coupé`); kill(); }, cfg.timeout_s * 1000);
      proc.p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: input.text }] } }) + "\n");
      let lastWasText = false, sawText = false, full = "";
      const info: Record<string, unknown> = {};
      try {
        for (;;) {
          const ev = await proc.q.next();
          if (ev === null) { info.error = "processus terminé"; break; }
          if (ev.type === "system" && ev.subtype === "init") {
            // Contrôle de sécurité : une nouvelle version du CLI pourrait ajouter un outil.
            const extra = ((ev.tools ?? []) as string[]).filter((t) => !t.startsWith("mcp__floppy__"));
            if (extra.length) {
              ctx.audit.write({ kind: "cli.unexpected_tools", cli: "claude", tools: extra });
              kill();
              throw new Error(`le CLI Claude expose des outils non prévus : ${extra.join(", ")}`);
            }
          } else if (ev.type === "stream_event") {
            const e = ev.event;
            if (e?.type === "content_block_start" && e.content_block?.type === "text") {
              if (sawText && !lastWasText) yield { type: "text", delta: " " } satisfies BrainEvent;
              lastWasText = true;
            } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
              sawText = true; lastWasText = true; full += e.delta.text;
              yield { type: "text", delta: e.delta.text };
            } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
              lastWasText = false;
            }
          } else if (ev.type === "assistant") {
            for (const c of ev.message?.content ?? []) if (c.type === "tool_use") { tools++; yield { type: "tool", name: String(c.name).replace(/^mcp__floppy__/, ""), args: c.input }; }
          } else if (ev.type === "result") {
            Object.assign(info, { subtype: ev.subtype, is_error: ev.is_error, duration_ms: ev.duration_ms, num_turns: ev.num_turns });
            break;
          }
        }
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", kill);
        proc.p.stdin.end();
        kill();
        // Trace de fin : distingue une vraie fin (« result »), un délai dépassé, un processus mort ou une annulation.
        if (timedOut) info.timeout = true;
        ctx.audit.write({ kind: "brain.cli", cli: "claude", model: pick().id, ms: Date.now() - t0, chars: full.length, tools, aborted: !!input.signal?.aborted, ...info });
        // Processus de réserve, déjà connecté au MCP, pour la demande suivante.
        if (!spare && ctx.alive) spare = spawnProc();
      }
      yield { type: "done", text: full.trim(), info };
    },
    stop: async () => { clearTimeout(refresh); spare = undefined; await Promise.all([...live].map((p) => killTree(p.p))); },
  };
}

export default definePlugin<Config>({
  manifest: {
    id: "brain-claude-cli",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "cerveau", label: { fr: "Cerveau", en: "Brain" } },
    ],
    description: "Claude Code (CLI) comme cerveau ou pour la délégation, branché seulement sur le serveur MCP Floppy.",
    provides: ["delegate", "llm", "brain", "completion"],
    inject: ["mcp"],
    permissions: { exec: ["claude"], cloud: true },
    addable: { section: "cerveau", label: "Claude Code", description: { fr: "Ton abonnement Claude, par le CLI officiel : Opus, Sonnet ou Haiku. Cerveau ou délégué.", en: "Your Claude subscription, through the official CLI: Opus, Sonnet or Haiku. Brain or delegate." }, cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const mcp = ctx.get("mcp");
    // Modèles proposés : `models`, plus l'ancien `completionModels` et `model` s'ils n'y sont pas.
    const models = [...cfg.models];
    for (const m of [...(cfg.completionModels ?? []), { id: cfg.model, label: labelOf(cfg.model) }]) {
      if (!models.some((x) => x.id === m.id)) models.push(m);
    }
    const find = (id: string) => models.find((m) => m.id === id);
    // Un seul élément « Claude Code » dans la rubrique Cerveau. Son modèle se choisit dans sa page (formulaire) :
    // gardé dans <home>/items/<entrée>.json ; il s'applique à la demande suivante, sans rien redémarrer.
    const store = ctx.items.store();
    const itemId = "claude";
    const T = (fr: string, en: string) => ({ fr, en });
    // Deux modèles : un pour le cerveau principal (« model »), un pour la délégation des tâches complexes (« delegateModel »).
    const pickOf = (key: "model" | "delegateModel", def: string) => () => {
      const id = String((store.data.edits[itemId] as Record<string, unknown> | undefined)?.[key] ?? def);
      return find(id) ?? { id, label: labelOf(id) };
    };
    const pick = pickOf("model", cfg.model);
    const pickDelegate = pickOf("delegateModel", cfg.delegateModel);
    const brains = new Set<{ renew(): void }>();
    const options = models.map((m) => ({ value: m.id, label: m.label }));
    const fields = [
      { key: "model", label: T("Modèle du cerveau principal", "Main brain model"), type: "select" as const, required: true, options,
        hint: T("Quand il répond lui-même. S'applique à la demande suivante.", "When it answers itself. Applies from the next request.") },
      { key: "delegateModel", label: T("Modèle de délégation", "Delegation model"), type: "select" as const, required: true, options,
        hint: T("Pour les tâches complexes que le cerveau principal lui confie.", "For the complex tasks the main brain hands over.") },
    ];
    ctx.items.declare({
      id: "claude-cli", section: "cerveau", order: 30, offers: ["llm", "delegate"],
      label: T("Claude Code (CLI)", "Claude Code (CLI)"),
      description: T("Ton abonnement Claude, par le CLI officiel. Aucune clé d'API.", "Your Claude subscription, through the official CLI. No API key."),
      badge: T("cloud", "cloud"),
      kinds: [{ id: "cli", label: T("Claude Code (CLI)", "Claude Code (CLI)"), fields }],
      list: () => {
        const on = store.isEnabled(itemId);
        const m = pick();
        const d = pickDelegate();
        return [{
          id: itemId, kind: "cli", label: T("Claude Code (CLI)", "Claude Code (CLI)"), enabled: on, cloud: true,
          aliases: ["claude", "claude code", m.id], values: { model: m.id, delegateModel: d.id },
          detail: T(`principal : ${m.label} · délégation : ${d.label}`, `main: ${m.label} · delegation: ${d.label}`),
          status: on ? "ok" : "off",
          statusText: on ? undefined : T("désactivé : plus proposé", "disabled: no longer offered"),
          editable: true, removable: false, toggleable: true,
        }];
      },
      update: async (id, values) => {
        if (id !== itemId) return { ok: false, text: T(`Élément inconnu : ${id}`, `Unknown item: ${id}`) };
        const m = find(String(values.model ?? pick().id));
        const d = find(String(values.delegateModel ?? pickDelegate().id));
        if (!m || !d) {
          const bad = String(!m ? values.model : values.delegateModel);
          return { ok: false, text: T(`Modèle inconnu : ${bad}`, `Unknown model: ${bad}`) };
        }
        store.update(itemId, { model: m.id, delegateModel: d.id });
        for (const b of brains) b.renew();
        ctx.items.changed();
        return { ok: true, text: T(`Claude Code : ${m.label} en principal, ${d.label} en délégation.`, `Claude Code: ${m.label} as main, ${d.label} for delegation.`) };
      },
      setEnabled: async (id, on) => {
        if (id !== itemId) return { ok: false, text: T(`Élément inconnu : ${id}`, `Unknown item: ${id}`) };
        store.setEnabled(itemId, on);
        ctx.items.changed();
        return { ok: true, text: on ? T("Claude Code activé.", "Claude Code enabled.")
          : T("Claude Code désactivé : plus proposé (rien n'est supprimé).", "Claude Code disabled: no longer offered (nothing is deleted).") };
      },
    });
    const items = () => store.isEnabled(itemId) ? [{ id: itemId, label: T("Claude Code (CLI)", "Claude Code (CLI)"), aliases: ["claude", "claude code", "anthropic"], cloud: true }] : [];
    // Choix gardés quand Claude avait un élément par modèle : ils reviennent sur l'élément unique.
    const renamed = Object.fromEntries(models.map((m) => [m.id, itemId]));
    /** Démarre l'agent dans son fork : le processus du CLI vit et meurt avec lui (rien ne tourne s'il ne sert pas). */
    const brainIn = (f: Context, which: () => { id: string; label: string }) => {
      const b = makeBrain(f, cfg, mcp, which);
      b.enabled = () => store.isEnabled(itemId);
      brains.add(b);
      f.effect(() => { brains.delete(b); return b.stop(); });
      return b;
    };
    if (cfg.as.includes("delegate")) ctx.offer("delegate", { items, renamed, start(f) { f.provide("delegate", brainIn(f, pickDelegate)); } });
    ctx.offer("llm", { items, renamed, start(f) {
      const b = brainIn(f, pick);
      f.provide("llm", { get label() { return b.label ?? "Claude"; }, get model() { return pick().id; }, cloud: true, agent: b });
    } });
    // Appels ponctuels (tri, résumé : slot du plugin qui s'en sert) : un modèle par élément, un processus du CLI par appel.
    ctx.offer("completion", {
      items: () => store.isEnabled(itemId) ? models.map((m) => ({ id: m.id, label: m.label, aliases: [m.id], cloud: true })) : [],
      start(f, id) {
        const m = find(id);
        if (!m) throw new Error(`modèle Claude inconnu : ${id}`);
        f.provide("completion", makeCompletion(f, cfg, m.id, m.label));
      },
    });
    // Montage B (sans GPU) : Claude comme cerveau direct de la conversation.
    if (cfg.as.includes("brain")) {
      const b = makeBrain(ctx, cfg, mcp, pick);
      brains.add(b);
      ctx.effect(() => b.stop());
      ctx.provide("brain", b);
    }
  },
});
