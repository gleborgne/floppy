// Plugin `brain-codex-cli` : Codex (CLI officiel d'OpenAI, déjà connecté par l'utilisateur) comme cerveau.
// - Offert modèle par modèle : cerveau principal (slot brain.main, service llm « agent ») ou délégué (slot brain.delegate).
// - `codex app-server` (JSON-RPC sur stdin/stdout) : un fil (thread) par conversation, gardé jusqu'à reset.
// - Le CLI n'a QUE le serveur MCP Floppy : mêmes outils, même accord, même journal que les autres cerveaux.
//   Shell, web, plugins, navigateur… sont coupés par des surcharges -c ; bac à sable en lecture seule ;
//   toute demande d'accord du CLI (commande, fichier) est refusée.
// - On ne lit, ne copie ni ne stocke jamais les identifiants du CLI. On ne touche pas à sa config globale.
// Port de CodexBrain (prototypes/cli-brain/src/brains.ts) et de CodexRunner (plugin coder).
import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentPrompt, definePlugin, findExe, killTree, type Context } from "@floppy/core";
import type { BrainEvent, BrainService, McpEndpoint } from "@floppy/contracts";

import { agentEnv, codexMcpOverrides, userCodexMcpNames, offerAgent, scopedAgentRun, createModelCatalog, discoverCodexModels, CliConversation, ReplyTags, withEmotionTags } from "@floppy/agent-cli";
const Config = z.object({
  /** Programme `codex` (défaut : cherché dans le PATH). */
  exe: z.string().optional(),
  /** Arguments ajoutés avant les autres (pour les tests : un script devant un faux CLI). */
  exeArgs: z.array(z.string()).default([]),
  /** Modèles de secours et ajouts personnels ; complétés par le catalogue de Codex (`model/list`). */
  models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1).default([
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ]),
  /** Effort de réflexion (low, medium, high…). Vide : celui du modèle. */
  effort: z.string().optional(),
  cwd: z.string().optional(),
  timeout_s: z.number().default(120),
  /** Étiquettes d'émotion en tête de réponse (« [content] … ») : visage et voix, retirées du texte. Comme aisdk. */
  emotions: z.boolean().default(true),
  /** Lire ~/.codex/config.toml pour couper les serveurs MCP de l'utilisateur (tests : false). */
  userMcp: z.boolean().default(true),
});
type Config = z.infer<typeof Config>;

/** Environnement propre : pas de variables d'une session parente. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return agentEnv(extra, { also: ["HOME", "CODEX_HOME"] });
}

/** Surcharges -c : rien d'autre que le serveur MCP Floppy (pas de shell, de web, de plugins, de mémoire…). */
export function codexOverrides(mcpUrl: string, tools: string[], userMcp: string[] = []): string[] {
  // Pas de shell. Nos outils passent sans question côté Codex : l'accord est tenu par le noyau (serveur MCP Floppy).
  const c = codexMcpOverrides({ mcpUrl, tools, userMcp, alsoOff: ["shell_tool", "unified_exec"] });
  c.push("-c", 'web_search="disabled"', "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
    "-c", "skills.include_instructions=false", "-c", "tools.update_plan.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false", "-c", "features.multi_agent_v2=false", "-c", "project_doc_max_bytes=0",
    "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false");
  return c;
}

type Notif = { method: string; params?: any };

/** Un processus `codex app-server` et ses fils (un par session de conversation). */
/** Modèle choisi, relu à chaque nouveau fil (le changer ne redémarre rien). */
export type Pick = () => { id: string; label: string };

export function makeCodexBrain(ctx: Context, cfg: Config, mcp: McpEndpoint, exe: string, pick: Pick): BrainService & { stop(): Promise<void>; renew(): void } {
  const cwd = cfg.cwd ?? ctx.workspace();
  let p: ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  /** Abonnés aux notifications (un par tour en cours). */
  const listeners = new Set<(n: Notif) => void>();
  const threads = new Map<string, { id: string; conversation: CliConversation }>();
  let stderr = "";

  const write = (obj: object) => { p?.stdin.write(JSON.stringify(obj) + "\n"); };
  const request = (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    write({ jsonrpc: "2.0", id, method, params });
    return new Promise((ok, err) => pending.set(id, { ok, err }));
  };
  /** Demandes du CLI vers le client : l'accord arrive à Floppy (au code), jamais au modèle. Tout est refusé sauf notre MCP. */
  const onServerRequest = (m: any) => {
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "item/commandExecution/requestApproval": case "item/fileChange/requestApproval":
        ctx.audit.write({ kind: "cli.denied", cli: "codex", request: m.method });
        return reply({ decision: "decline" });
      case "execCommandApproval": case "applyPatchApproval":
        return reply({ decision: { denied: { rejection: "Interdit par Floppy." } } });
      case "mcpServer/elicitation/request":
        return reply(m.params?.serverName === "floppy" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null });
      default:
        write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "refusé par Floppy" } });
    }
  };
  const onExit = (why: string) => {
    for (const w of pending.values()) w.err(new Error(why));
    pending.clear();
    p = undefined; ready = undefined; threads.clear();
    for (const l of listeners) l({ method: "floppy/exit", params: { why } });
  };
  const boot = (): Promise<void> => {
    if (ready) return ready;
    mkdirSync(cwd, { recursive: true });
    const tools = ctx.tools.list().map((t) => t.name);
    const proc = ctx.spawn(exe, [...cfg.exeArgs, "app-server", ...codexOverrides(mcp.url, tools, cfg.userMcp ? userCodexMcpNames() : [])], {
      cwd, windowsHide: true, env: cleanEnv({ FLOPPY_MCP_TOKEN: mcp.token, RUST_LOG: "warn" }),
    }) as ChildProcessWithoutNullStreams;
    p = proc;
    proc.stdin.on("error", () => {});
    proc.stderr.on("data", (b) => { stderr = (stderr + String(b)).slice(-2000); ctx.log("debug", `codex : ${String(b).slice(0, 300)}`); });
    proc.on("error", (e) => { if (p === proc) onExit(`impossible de lancer Codex : ${e.message}`); });
    proc.on("exit", () => { if (p === proc) onExit(stderr.trim().split("\n").pop() || "le processus Codex s'est arrêté"); });
    createInterface({ input: proc.stdout }).on("line", (l) => {
      let m: any;
      try { m = JSON.parse(l); } catch { return; }
      if (m.id !== undefined && m.method) onServerRequest(m);
      else if (m.id !== undefined) {
        const w = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) w?.err(new Error(m.error.message ?? JSON.stringify(m.error))); else w?.ok(m.result);
      } else if (m.method) for (const fn of listeners) fn(m);
    });
    ready = (async () => {
      await request("initialize", { clientInfo: { name: "floppy", title: "Floppy", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      write({ jsonrpc: "2.0", method: "initialized" });
    })();
    ready.catch(() => {});
    return ready;
  };
  // Outils ajoutés ou retirés : le processus garde l'ancienne liste (prompt, accords) ; on le relance au prochain tour.
  let refresh: NodeJS.Timeout | undefined;
  ctx.tools.onChange(() => {
    clearTimeout(refresh);
    refresh = setTimeout(() => {
      if (!p || listeners.size || !ctx.alive) return;
      const old = p;
      p = undefined; ready = undefined; threads.clear();
      void killTree(old);
    }, 1000);
    refresh.unref?.();
  });

  return {
    get name() { return `codex:${pick().id}`; },
    get label() { return pick().label; },
    get aliases() { return ["codex", "openai", "gpt", pick().id, pick().label.toLowerCase()]; },
    keepsHistory: true,
    reset: (session) => { threads.delete(session); },
    /** Modèle changé : les fils suivants partent avec le nouveau. */
    renew: () => { threads.clear(); },
    async *run(input) {
      const info: Record<string, unknown> = {};
      const queue: Notif[] = [];
      let wake: (() => void) | undefined;
      const listener = (n: Notif) => { queue.push(n); wake?.(); };
      listeners.add(listener);
      let threadId: string | undefined;
      let turnId: string | undefined;
      const interrupt = () => {
        if (threadId && turnId) void request("turn/interrupt", { threadId, turnId }).catch(() => {});
        else if (p) void killTree(p);
      };
      input.signal?.addEventListener("abort", interrupt, { once: true });
      const timer = setTimeout(() => { info.error = "délai dépassé"; interrupt(); listener({ method: "floppy/exit", params: { why: "délai dépassé" } }); }, cfg.timeout_s * 1000);
      let full = "", lastItem: string | undefined;
      const tags = new ReplyTags(cfg.emotions);
      try {
        await boot();
        let thread = threads.get(input.session);
        if (!thread) {
          const r = await request("thread/start", {
            model: pick().id, cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, approvalsReviewer: "user",
            baseInstructions: withEmotionTags(agentPrompt(ctx.assistant.name, ctx.tools.list(), ctx.assistant.language), cfg.emotions, ctx.assistant.language),
          });
          thread = { id: String(r.thread.id), conversation: new CliConversation() };
          threads.set(input.session, thread);
        }
        threadId = thread.id;
        const r = await request("turn/start", {
          threadId, input: [{ type: "text", text: thread.conversation.prepare(input, ctx.assistant.language), text_elements: [] }], ...(cfg.effort ? { effort: cfg.effort } : {}),
        });
        turnId = r?.turn?.id;
        for (;;) {
          while (!queue.length) await new Promise<void>((ok) => { wake = ok; });
          wake = undefined;
          const n = queue.shift()!;
          const pr = n.params ?? {};
          if (n.method === "floppy/exit") { info.error ??= pr.why; break; }
          if (pr.threadId && pr.threadId !== threadId) continue;
          if (n.method === "item/agentMessage/delta") {
            if (full && lastItem !== pr.itemId) {
              yield* tags.newSegment(); // nouveau message : l'étiquette de tête peut revenir
              full += " "; yield { type: "text", delta: " " } satisfies BrainEvent;
            }
            lastItem = pr.itemId;
            for (const out of tags.push(String(pr.delta ?? ""))) { if (out.type === "text") full += out.delta; yield out; }
          } else if (n.method === "item/started" && pr.item?.type === "mcpToolCall") {
            yield { type: "tool", name: String(pr.item.tool), args: pr.item.arguments };
          } else if (n.method === "item/started" && ["commandExecution", "fileChange", "webSearch"].includes(pr.item?.type)) {
            // Ne devrait jamais arriver (coupés) : on le note.
            ctx.audit.write({ kind: "cli.unexpected_tools", cli: "codex", tools: [pr.item.type] });
          } else if (n.method === "error") {
            info.error = JSON.stringify(pr).slice(0, 300);
          } else if (n.method === "turn/completed") {
            info.turn_status = pr.turn?.status;
            if (pr.turn?.status === "failed") info.error = pr.turn?.error?.message ?? info.error ?? "erreur";
            break;
          }
        }
      } catch (error) {
        if (threads.get(input.session)?.id === threadId) threads.delete(input.session);
        throw error;
      } finally {
        if (info.error && threads.get(input.session)?.id === threadId) threads.delete(input.session);
        clearTimeout(timer);
        listeners.delete(listener);
        input.signal?.removeEventListener("abort", interrupt);
      }
      for (const out of tags.end()) { if (out.type === "text") full += out.delta; yield out; }
      yield { type: "done", text: full.trim(), info };
    },
    stop: async () => {
      clearTimeout(refresh);
      const old = p;
      p = undefined; ready = undefined;
      if (old) { old.stdin.end(); await killTree(old); }
    },
  };
}

export default definePlugin<Config>({
  manifest: {
    id: "brain-codex-cli",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "brain", label: { fr: "Cerveau", en: "Brain" } },
    ],
    description: "Codex (CLI d'OpenAI) comme cerveau ou pour la délégation, branché seulement sur le serveur MCP Floppy.",
    provides: ["delegate", "llm", "agent"],
    inject: ["mcp"],
    permissions: { exec: ["codex"], "fs.write": ["workspaces/brain-codex-cli"], cloud: true },
    addable: { section: "brain", label: "Codex", description: { fr: "Ton abonnement ChatGPT, par le CLI Codex. Cerveau ou délégué.", en: "Your ChatGPT subscription, through the Codex CLI. Brain or delegate." }, cloud: true, single: true, program: "codex", aliases: ["codex", "openai", "chatgpt"] },
  },
  config: Config,
  apply(ctx, cfg) {
    const mcp = ctx.get("mcp");
    const exe = cfg.exe ?? findExe("codex");
    const find = (id: string) => catalog.find(id);
    // Un seul élément dans la rubrique Cerveau. Son modèle se choisit dans sa page (formulaire) : gardé dans
    // <home>/items/<entrée>.json, appliqué à la demande suivante sans rien redémarrer.
    const store = ctx.items.store();
    const itemId = "codex";
    const T = (fr: string, en: string) => ({ fr, en });
    // Deux modèles : un pour le cerveau principal (« model »), un pour la délégation des tâches complexes (« delegateModel »).
    const pickOf = (key: "model" | "delegateModel", def: string) => () => {
      const id = String((store.data.edits[itemId] as Record<string, unknown> | undefined)?.[key] ?? def);
      return find(id) ?? { id, label: id };
    };
    const pick = pickOf("model", cfg.models[0]!.id);
    const pickDelegate = pickOf("delegateModel", cfg.models[0]!.id);
    const catalog = createModelCatalog(ctx, cfg.models, () => [pick(), pickDelegate()], () => {
      if (!exe) throw new Error("programme codex introuvable");
      return discoverCodexModels(ctx, {
        exe, args: [...cfg.exeArgs, "app-server", ...codexOverrides(mcp.url, [], cfg.userMcp ? userCodexMcpNames() : []), "-c", "mcp_servers.floppy.enabled=false"],
        cwd: ctx.workspace("model-catalog"), env: cleanEnv({ RUST_LOG: "warn" }),
      });
    });
    catalog.touch(false);
    offerAgent(ctx, {
      id: "codex", label: "Codex", program: "codex", aliases: ["codex"],
      args: (prompt, model) => [...(model ? ["-m", model] : []), prompt],
    }, { exe: () => exe, enabled: () => store.isEnabled(itemId), run: (f) => scopedAgentRun(f, mcp, (scope, cwd, input) =>
      makeCodexBrain(f, { ...cfg, cwd, emotions: false }, scope, exe!, () => input.model ? { id: input.model, label: input.model } : pickDelegate())) });
    const brains = new Set<{ renew(): void }>();
    const name = T("Codex", "Codex");
    ctx.items.declare({
      id: "codex-cli", section: "brain", order: 31, offers: ["llm", "delegate"],
      label: name,
      description: T("Ton abonnement ChatGPT, par le CLI Codex. Aucune clé d'API.", "Your ChatGPT subscription, through the Codex CLI. No API key."),
      badge: T("cloud", "cloud"),
      kinds: [{ id: "cli", label: name, fields: [
        { key: "model", label: T("Modèle du cerveau principal", "Main brain model"), type: "select", required: true,
          options: catalog.options,
          hint: T("Quand il répond lui-même. S'applique à la demande suivante.", "When it answers itself. Applies from the next request.") },
        { key: "delegateModel", label: T("Modèle de délégation", "Delegation model"), type: "select", required: true,
          options: catalog.options,
          hint: T("Pour les tâches complexes que le cerveau principal lui confie.", "For the complex tasks the main brain hands over.") },
      ] }],
      list: () => {
        const on = store.isEnabled(itemId);
        catalog.touch(on && !!exe);
        const m = pick();
        const d = pickDelegate();
        return [{
          id: itemId, kind: "cli", label: name, enabled: on, cloud: true, aliases: ["codex", "openai", "chatgpt", m.id], values: { model: m.id, delegateModel: d.id },
          detail: T(`principal : ${m.label} · délégation : ${d.label}`, `main: ${m.label} · delegation: ${d.label}`),
          actions: exe ? catalog.actions : [],
          status: !exe || catalog.warning ? "warn" : on ? "ok" : "off",
          statusText: !exe ? T("programme codex introuvable : installe Codex", "codex program not found: install Codex")
            : on ? catalog.warning : T("désactivé : plus proposé", "disabled: no longer offered"),
          editable: true, removable: false, toggleable: true,
        }];
      },
      action: async (id, action) => id === itemId && action === "refresh-models" ? catalog.refresh()
        : { ok: false, text: T("Action inconnue.", "Unknown action.") },
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
        return { ok: true, text: T(`Codex : ${m.label} en principal, ${d.label} en délégation.`, `Codex: ${m.label} as main, ${d.label} for delegation.`) };
      },
      setEnabled: async (id, on) => {
        if (id !== itemId) return { ok: false, text: T(`Élément inconnu : ${id}`, `Unknown item: ${id}`) };
        store.setEnabled(itemId, on);
        ctx.items.changed();
        return { ok: true, text: on ? T("Codex activé.", "Codex enabled.") : T("Codex désactivé (rien n'est supprimé).", "Codex disabled (nothing is deleted).") };
      },
    });
    const items = () => exe && store.isEnabled(itemId) ? [{ id: itemId, label: name, aliases: ["codex", "openai", "chatgpt"], cloud: true }] : [];
    /** Démarre l'agent dans son fork : ses processus vivent et meurent avec lui. */
    const brainIn = (f: Context, which: () => { id: string; label: string }) => {
      if (!exe) throw new Error("programme codex introuvable");
      const b = makeCodexBrain(f, cfg, mcp, exe, which);
      b.enabled = () => store.isEnabled(itemId);
      brains.add(b);
      f.effect(() => { brains.delete(b); return b.stop(); });
      return b;
    };
    ctx.offer("delegate", { items, start(f) { f.provide("delegate", brainIn(f, pickDelegate)); } });
    ctx.offer("llm", { items, start(f) {
      const b = brainIn(f, pick);
      f.provide("llm", { get label() { return b.label ?? "Codex"; }, get model() { return pick().id; }, cloud: true, agent: b });
    } });
  },
});
