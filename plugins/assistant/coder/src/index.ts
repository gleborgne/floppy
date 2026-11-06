// Plugin `coder` : l'assistant IA de la fenêtre des réglages, avec le CLI de l'utilisateur (Claude Code ou Codex).
// - Son abonnement, jamais une clé API. On ne lit ni ne copie les identifiants du CLI.
// - Mode `reglages` : aucun outil intégré, seulement les outils de réglages du serveur MCP Floppy (accès restreint).
// - Mode `plugin` : écrire un plugin dans <home>/plugins ; chaque écriture est validée par l'utilisateur,
//   et tout chemin hors de ce dossier est refusé, quelle que soit la réponse.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { definePlugin, T, TextError, type CoderAgent, type CoderEvent, type CoderMode, type CoderService, type Context } from "@floppy/core";
import type { McpEndpoint, ScopedEndpoint } from "@floppy/core";
import { findExe, isInside, say, type Runner, type RunnerDeps, type RunnerEvent } from "./common.ts";
import { ClaudeRunner } from "./claude.ts";
import { CodexRunner } from "./codex.ts";
import { copyKit } from "./kit.ts";
import { systemPrompt } from "./prompts.ts";
import { itemsTools } from "./items-tools.ts";
import { REVIEW_AGENTS, runReview, type ReviewAgent } from "./review.ts";

export { copyKit, KIT_DIR } from "./kit.ts";
export { claudeArgs } from "./claude.ts";
export { codexOverrides } from "./codex.ts";
export { reviewArgs, runReview, REVIEW_SYSTEM, type ReviewAgent } from "./review.ts";

const MAX_SESSIONS = 3;
const REGLAGES_TOOLS = ["lister_reglages", "changer_reglage", "annuler_reglage", "etat_plugins", "lister_elements", "activer_element"];
const PLUGIN_TOOLS = ["tester_plugin", "recharger_plugins", "etat_plugins", "lister_reglages"];

const Config = z.object({
  /** Chemin du CLI Claude (défaut : trouvé dans le PATH). */
  claudeExe: z.string().optional(),
  codexExe: z.string().optional(),
  /** Arguments avant ceux du CLI (tests : `node faux-cli.mjs`). */
  claudeExeArgs: z.array(z.string()).default([]),
  codexExeArgs: z.array(z.string()).default([]),
  /** CLI Antigravity (relecture des plugins tiers seulement). */
  agyExe: z.string().optional(),
  agyExeArgs: z.array(z.string()).default([]),
  /** Durée maximale d'une relecture de plugin tiers. */
  review_timeout_s: z.number().default(300),
  /** Délai de réponse à une validation avant refus. */
  permission_timeout_s: z.number().default(600),
});
type Config = z.infer<typeof Config>;

interface Session {
  id: string;
  agent: CoderAgent;
  mode: CoderMode;
  runner: Runner;
  scoped: ScopedEndpoint;
  pending: Map<string, (allow: boolean) => void>;
}

function readBefore(path: string): string | undefined {
  try {
    if (!existsSync(path) || statSync(path).size > 200_000) return undefined;
    return readFileSync(path, "utf8");
  } catch { return undefined; }
}

function makeCoder(ctx: Context, cfg: Config, mcp: McpEndpoint, model: () => string, web: () => boolean = () => false): CoderService & { stop(): Promise<void> } {
  const pluginsDir = join(ctx.home, "plugins");
  const listeners = new Set<(e: CoderEvent) => void>();
  const sessions = new Map<string, Session>();
  /** Langue des messages montrés à l'utilisateur : celle de l'assistant (relue à chaque fois). */
  // L'assistant IA vit dans la fenêtre des réglages : il suit la langue de l'interface.
  const lang = (): string => ctx.uiLang();
  const emit = (e: CoderEvent): void => { for (const fn of [...listeners]) { try { fn(e); } catch { /* un abonné ne casse pas les autres */ } } };
  let exes: { claude?: string; codex?: string } | undefined;
  const find = (): { claude?: string; codex?: string } => {
    if (!exes) {
      const claude = cfg.claudeExe ?? findExe("claude");
      const codex = cfg.codexExe ?? findExe("codex");
      exes = { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
    }
    return exes;
  };

  /** Demande à l'utilisateur et attend sa réponse (refus après le délai). */
  const ask = (s: Session, req: Parameters<RunnerDeps["ask"]>[0]): Promise<boolean> => new Promise((ok) => {
    const id = randomUUID();
    const done = (allow: boolean, by: string): void => {
      if (!s.pending.delete(id)) return;
      clearTimeout(timer);
      ctx.audit.write({ kind: "coder.permission", session: s.id, tool: req.tool, path: req.diff?.path, allow, by });
      ok(allow);
    };
    const timer = setTimeout(() => done(false, "timeout"), cfg.permission_timeout_s * 1000);
    s.pending.set(id, (allow) => done(allow, "user"));
    emit({ type: "permission", sessionId: s.id, id, tool: req.tool, description: req.description, ...(req.input !== undefined ? { input: req.input } : {}), ...(req.diff ? { diff: req.diff } : {}) });
  });

  const denyAll = (s: Session): void => { for (const f of [...s.pending.values()]) f(false); };

  /** Outil `permission` (--permission-prompt-tool de Claude) : décide, ou demande à l'utilisateur. */
  const permissionTool = (s: Session) => ({
    name: "permission",
    description: "Réservé à l'application : validation des actions de l'agent.",
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    handler: async (args: Record<string, unknown>): Promise<{ text: string }> => {
      const tool = String(args.tool_name ?? "");
      const input = (args.input ?? {}) as Record<string, unknown>;
      const deny = (message: string, reason: string, path?: string): { text: string } => {
        ctx.audit.write({ kind: "coder.permission", session: s.id, tool, path, allow: false, by: reason });
        return { text: JSON.stringify({ behavior: "deny", message }) };
      };
      const allow = (): { text: string } => ({ text: JSON.stringify({ behavior: "allow", updatedInput: input }) });
      const raw = input.file_path ?? input.notebook_path ?? input.path;
      const path = typeof raw === "string" && raw ? raw : undefined;
      if (s.mode !== "plugin") return deny("Aucune action n'est permise dans ce mode.", "mode");
      if (path !== undefined && !isInside(pluginsDir, path)) {
        return deny("Ce chemin est en dehors du dossier des plugins. Refusé.", "outside", path);
      }
      if (tool === "Glob" || tool === "Grep") {
        // Le motif ne doit pas sortir du dossier : ni absolu, ni « .. ». (Grep : `pattern` est une regex, seul `glob` est un chemin.)
        const pat = tool === "Glob" ? input.pattern : input.glob;
        if (typeof pat === "string" && pat && (isAbsolute(pat) || /^[a-z]:/i.test(pat) || pat.split(/[\\/]/).includes(".."))) {
          return deny("Ce motif sort du dossier des plugins. Refusé.", "outside", pat);
        }
      }
      if (["Read", "Glob", "Grep"].includes(tool)) return allow();
      let diff: { path: string; before?: string; after?: string } | undefined;
      let description: string;
      if (tool === "Write" && path) {
        const before = readBefore(path);
        diff = { path, ...(before !== undefined ? { before } : {}), after: String(input.content ?? "") };
        description = before === undefined ? say(lang(), `Créer le fichier ${path}`, `Create the file ${path}`) : say(lang(), `Remplacer le contenu de ${path}`, `Replace the content of ${path}`);
      } else if (tool === "Edit" && path) {
        diff = { path, before: String(input.old_string ?? ""), after: String(input.new_string ?? "") };
        description = say(lang(), `Modifier le fichier ${path}`, `Edit the file ${path}`);
      } else if (tool === "MultiEdit" && path) {
        const edits = (Array.isArray(input.edits) ? input.edits : []) as { old_string?: string; new_string?: string }[];
        diff = { path, before: edits.map((e) => e.old_string ?? "").join("\n…\n"), after: edits.map((e) => e.new_string ?? "").join("\n…\n") };
        description = say(lang(), `Modifier le fichier ${path}`, `Edit the file ${path}`);
      } else {
        return deny("Cette action n'est pas permise.", "tool");
      }
      const yes = await ask(s, { tool, description, input, diff });
      return yes ? allow() : deny("L'utilisateur a refusé. Ne réessaie pas à l'identique : demande-lui ce qu'il veut changer.", "user", path);
    },
  });

  return {
    async agents() {
      const e = find();
      return [
        { id: "claude", label: "Claude Code", available: !!e.claude, loginHint: "claude /login" },
        { id: "codex", label: "Codex", available: !!e.codex, loginHint: "codex login" },
      ];
    },

    async start({ agent, mode }) {
      if (sessions.size >= MAX_SESSIONS) throw new TextError(T("Trois conversations au maximum. Ferme-en une d'abord.", "Three conversations at most. Close one first."));
      const exe = (find() as Record<string, string | undefined>)[agent];
      if (!exe) {
        throw new TextError(agent === "claude" ? T("Claude Code n'est pas installé.", "Claude Code is not installed.")
          : agent === "codex" ? T("Codex n'est pas installé.", "Codex is not installed.") : T(`Agent inconnu : ${agent}.`, `Unknown agent: ${agent}.`));
      }
      const id = randomUUID();
      let cwd: string;
      if (mode === "plugin") {
        cwd = pluginsDir;
        const copied = copyKit(pluginsDir);
        if (copied.length) ctx.log("info", `kit de développement copié : ${copied.join(", ")}`);
      } else {
        cwd = join(ctx.home, "coder-reglages");
        mkdirSync(cwd, { recursive: true });
      }
      const s = { id, agent, mode, pending: new Map() } as Session;
      // Mode réglages : outils des éléments en plus (chaque ajout / modification / suppression demande un clic).
      const itemExtras = mode === "plugin" ? [] : itemsTools(ctx, (req) => ask(s, req), lang);
      const extraTools = mode === "plugin" ? (agent === "claude" ? [permissionTool(s)] : []) : itemExtras;
      const mcpTools = mode === "plugin" ? PLUGIN_TOOLS : [...REGLAGES_TOOLS, ...itemExtras.map((t) => t.name)];
      s.scoped = mcp.scoped({ tools: mcpTools, ...(extraTools.length ? { extraTools } : {}) });
      // Les événements du démarrage partent après le retour de start() : l'appelant connaît alors l'id.
      let started = false;
      const early: CoderEvent[] = [];
      const deps: RunnerDeps = {
        emit: (e: RunnerEvent) => { const ev = { ...e, sessionId: id } as CoderEvent; if (started) emit(ev); else early.push(ev); },
        log: (l, m) => ctx.log(l, m),
        audit: (r) => ctx.audit.write({ ...r, session: id }),
        ask: (req) => ask(s, req),
        lang: lang(),
      };
      const useWeb = agent === "claude" && mode === "reglages" && web();
      const system = systemPrompt(mode, ctx.assistant.name, pluginsDir, useWeb, lang());
      sessions.set(id, s);
      ctx.audit.write({ kind: "coder.session_start", session: id, agent, mode });
      try {
        s.runner = agent === "claude"
          ? new ClaudeRunner({ exe, exeArgs: cfg.claudeExeArgs, mode, cwd, system, model, mcpUrl: s.scoped.url, mcpToken: s.scoped.token, mcpTools, web: useWeb }, deps)
          : new CodexRunner({ exe, exeArgs: cfg.codexExeArgs, mode, cwd, system, mcpUrl: s.scoped.url, mcpToken: s.scoped.token, mcpTools, pluginsDir }, deps);
      } catch (e) {
        sessions.delete(id);
        s.scoped.close();
        throw e;
      }
      started = true;
      setImmediate(() => { for (const ev of early) emit(ev); });
      return id;
    },

    send(sessionId, text) { sessions.get(sessionId)?.runner.send(text); },

    cancel(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      denyAll(s);
      s.runner.cancel();
    },

    answerPermission(sessionId, permissionId, allow) { sessions.get(sessionId)?.pending.get(permissionId)?.(allow); },

    close(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      sessions.delete(sessionId);
      denyAll(s);
      s.scoped.close();
      ctx.audit.write({ kind: "coder.session_stop", session: sessionId });
      void s.runner.close();
    },

    onEvent(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    async reviewers() {
      const e = find();
      const agy = cfg.agyExe ?? findExe("agy");
      return [
        { id: "claude", label: "Claude Code", available: !!e.claude, loginHint: "claude /login" },
        { id: "codex", label: "Codex", available: !!e.codex, loginHint: "codex login" },
        { id: "agy", label: "Antigravity", available: !!agy, loginHint: "agy" },
      ];
    },

    async review({ prompt, agent, signal }) {
      const e = { ...find(), agy: cfg.agyExe ?? findExe("agy") } as Record<ReviewAgent, string | undefined>;
      const pick = (agent ? [agent] : REVIEW_AGENTS).find((a) => REVIEW_AGENTS.includes(a as ReviewAgent) && e[a as ReviewAgent]) as ReviewAgent | undefined;
      if (!pick) {
        throw new TextError(agent
          ? T(`L'agent « ${agent} » n'est pas installé.`, `The agent "${agent}" is not installed.`)
          : T("Aucun agent de code installé (Claude Code, Codex ou Antigravity) : il en faut un pour relire un plugin tiers.", "No coding agent installed (Claude Code, Codex or Antigravity): one is needed to review a third-party plugin."));
      }
      const exeArgs = pick === "claude" ? cfg.claudeExeArgs : pick === "codex" ? cfg.codexExeArgs : cfg.agyExeArgs;
      ctx.audit.write({ kind: "coder.review", agent: pick, chars: prompt.length });
      const text = await runReview({ agent: pick, exe: e[pick]!, exeArgs, prompt, ...(pick === "claude" ? { model: model() } : {}), timeoutMs: cfg.review_timeout_s * 1000, ...(signal ? { signal } : {}) });
      return { agent: pick, text };
    },

    async stop() {
      for (const id of [...sessions.keys()]) this.close(id);
      listeners.clear();
    },
  };
}

export default definePlugin<Config>({
  manifest: {
    id: "coder",
    version: "0.1.0",
    licence: "MIT",
    description: "Assistant IA de la fenêtre des réglages : le CLI de l'utilisateur (Claude Code ou Codex), branché seulement sur des outils précis de Floppy.",
    provides: ["coder"],
    inject: ["mcp"],
    permissions: { exec: ["claude", "codex", "agy"], "fs.write": ["plugins"], cloud: true },
    sections: [{ id: "assistant", order: 70, view: "assistant", label: { fr: "Assistant IA", en: "AI assistant" }, description: { fr: "Discute avec un agent de code (Claude Code, Codex…) pour régler Floppy ou créer un plugin.", en: "Chat with a coding agent (Claude Code, Codex…) to tune Floppy or create a plugin." } }],
  },
  config: Config,
  async apply(ctx, cfg) {
    const exes = { claude: !!(cfg.claudeExe ?? findExe("claude")), codex: !!(cfg.codexExe ?? findExe("codex")) };
    let agent: CoderAgent = ctx.settings.saved<CoderAgent>("assistant_agent") ?? (exes.claude ? "claude" : "codex");
    let model = ctx.settings.saved<string>("assistant_modele_claude") ?? "sonnet";
    let web = ctx.settings.saved<boolean>("assistant_web") ?? true;
    ctx.settings.declare([
      {
        key: "assistant_agent", label: { fr: "Agent de l'assistant IA", en: "AI assistant agent" },
        description: { fr: "Le CLI utilisé par l'assistant IA des réglages : Claude Code ou Codex (ton abonnement, pas de clé API).", en: "The CLI used by the settings AI assistant: Claude Code or Codex (your subscription, no API key)." },
        type: "enum", section: "assistant", group: { fr: "Assistant IA", en: "AI assistant" }, risk: "free",
        options: [{ value: "claude", label: "Claude Code", aliases: ["claude"] }, { value: "codex", label: "Codex", aliases: ["codex", "openai"] }],
        get: () => agent, set: (v) => { agent = v as CoderAgent; },
      },
      {
        key: "assistant_modele_claude", label: { fr: "Modèle Claude de l'assistant IA", en: "AI assistant Claude model" },
        description: { fr: "Le modèle de Claude Code pour l'assistant IA des réglages.", en: "The Claude Code model for the settings AI assistant." },
        type: "enum", section: "assistant", group: { fr: "Assistant IA", en: "AI assistant" }, risk: "free",
        options: [{ value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }, { value: "haiku", label: "Haiku" }],
        get: () => model, set: (v) => { model = String(v); },
      },
      {
        key: "assistant_web", label: { fr: "Recherche web de l'assistant IA", en: "AI assistant web search" },
        description: {
          fr: "L'assistant des réglages peut chercher sur le web (ex. la documentation d'un serveur MCP). Claude Code seulement. Rien n'est ajouté sans ton clic.",
          en: "The settings assistant can search the web (e.g. an MCP server's documentation). Claude Code only. Nothing is added without your click.",
        },
        type: "boolean", section: "assistant", group: { fr: "Assistant IA", en: "AI assistant" }, risk: "free",
        get: () => web, set: (v) => { web = Boolean(v); },
      },
    ]);
    const coder = makeCoder(ctx, cfg, ctx.get("mcp"), () => model, () => web);
    ctx.effect(() => coder.stop());
    ctx.provide("coder", coder);
  },
});
