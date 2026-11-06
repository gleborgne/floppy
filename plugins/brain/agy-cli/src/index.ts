// Plugin `brain-agy-cli` : Antigravity (CLI `agy` de Google, déjà connecté par l'utilisateur) comme cerveau.
// - Offert modèle par modèle : cerveau principal (slot brain.main, service llm « agent ») ou délégué (slot brain.delegate).
// - agy n'a ni --mcp-config, ni --system-prompt, ni --tools. On l'isole comme au prototype 3 quater (complément agy) :
//   * une « maison » à part (USERPROFILE/HOME = <données Floppy>/agy-home) : ses réglages et son mcp_config.json
//     (Floppy seul). Ni les serveurs MCP, ni les hooks, ni les réglages de l'utilisateur ne sont chargés ; ~/.gemini
//     n'est jamais modifié. La connexion Google n'est pas dans ~/.gemini : elle marche quand même.
//   * un agent de l'espace de travail (.agents/agents/floppy.md) : notre prompt et la liste blanche `tools: [view_file]`.
//     Sans elle, agy donne aussi search_web (web ouvert, qu'aucune règle ne bloque) et schedule.
//   * des règles de session (--settings, jamais enregistrées) : refus des commandes, écritures, URL.
// - Limite connue : l'événement `init` liste toujours ~60 outils ; on ne peut pas vérifier la vraie liste au démarrage.
// - Un processus par demande, avec un processus de réserve déjà lancé. Port d'AgyBrain (prototypes/cli-brain/src/brains.ts).
import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentPrompt, definePlugin, findExe, killTree, type BrainEvent, type BrainService, type Context, type McpEndpoint } from "@floppy/core";

const Config = z.object({
  /** Programme `agy` (défaut : cherché dans le PATH). */
  exe: z.string().optional(),
  /** Arguments ajoutés avant les autres (pour les tests : un script devant un faux CLI). */
  exeArgs: z.array(z.string()).default([]),
  /** Modèles proposés : `id` = nom du modèle pour agy (liste : `agy models`). */
  models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1).default([
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash" },
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon" },
  ]),
  cwd: z.string().optional(),
  timeout_s: z.number().default(120),
});
type Config = z.infer<typeof Config>;

/** Environnement propre, avec la maison isolée. */
function agyEnv(home: string): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|USERNAME|USERDOMAIN|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|COMPUTERNAME|LANG|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return { ...env, USERPROFILE: home, HOME: home };
}

/** Règles de session : seulement nos outils MCP et la lecture de leurs schémas ; ni commande, ni écriture, ni URL. */
export function agySettings(schemasDir: string): string {
  return JSON.stringify({
    permissions: {
      allow: ["mcp(floppy/*)", `read_file(${schemasDir})`],
      deny: ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "unsandboxed(*)"],
    },
    allowNonWorkspaceAccess: false, enableTerminalSandbox: true, disableSlashCommands: true, notifications: false,
  });
}

/** Fichier d'agent : notre prompt et la liste blanche d'outils (view_file seul, pour lire les schémas MCP). */
export function agyAgentFile(system: string): string {
  return `---\nname: floppy\ndescription: Assistant vocal Floppy.\ntools: [view_file]\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\n${system}\n`;
}

/** Prépare la maison isolée et le dossier de travail. Le jeton MCP (un par lancement de Floppy) reste dans les données de Floppy. */
function prepare(home: string, cwd: string, mcp: McpEndpoint, settings: string, system: string): void {
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), settings);
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { floppy: {
    serverUrl: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, disabled: false } } }, null, 2));
  mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "agents", "floppy.md"), agyAgentFile(system));
}

class LineQueue {
  private buf: unknown[] = [];
  private waiters: ((v: unknown) => void)[] = [];
  private closed = false;
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
export type Pick = () => { id: string; label: string };

export function makeAgyBrain(ctx: Context, cfg: Config, mcp: McpEndpoint, exe: string, pick: Pick): BrainService & { stop(): Promise<void>; renew(): void } {
  const home = join(ctx.home, "agy-home");
  const cwd = cfg.cwd ?? join(ctx.home, "agy-workdir");
  const schemas = join(home, ".gemini", "antigravity-cli", "mcp");
  const settings = agySettings(schemas);
  const schemaRead = (p: unknown) => String(p ?? "").toLowerCase().startsWith(schemas.toLowerCase());
  // Le prompt suit les outils visibles : réécrit avant chaque lancement d'un processus.
  const spawnProc = (): Proc => {
    prepare(home, cwd, mcp, settings, agentPrompt(ctx.assistant.name, ctx.tools.list(), ctx.assistant.language));
    const p = ctx.spawn(exe, [...cfg.exeArgs,
      "--input-format", "stream-json", "--output-format", "stream-json", "--model", pick().id, "--agent", "floppy",
      "--settings", settings, "--disable-slash-commands",
    ], { cwd, windowsHide: true, env: agyEnv(home) }) as ChildProcessWithoutNullStreams;
    p.stdin.on("error", () => {});
    p.stderr.on("data", (d) => ctx.log("debug", `agy : ${String(d).slice(0, 300)}`));
    p.on("error", (e) => ctx.log("error", `agy : ${e.message}`));
    const proc = { p, q: new LineQueue(p.stdout) };
    live.add(proc);
    p.on("exit", () => { live.delete(proc); if (spare === proc) spare = undefined; });
    return proc;
  };
  const live = new Set<Proc>();
  let spare: Proc | undefined = spawnProc(); // réchauffé dès le démarrage du fork
  /** La réserve a l'ancien prompt ou l'ancien modèle : on la relance. */
  const renew = () => {
    const old = spare;
    if (!old || !ctx.alive) return;
    spare = undefined;
    void killTree(old.p);
    spare = spawnProc();
  };
  // Outils ajoutés ou retirés : on attend que ça se calme avant de relancer la réserve.
  let refresh: NodeJS.Timeout | undefined;
  ctx.tools.onChange(() => {
    clearTimeout(refresh);
    refresh = setTimeout(renew, 1000);
    refresh.unref?.();
  });

  return {
    get name() { return `agy:${pick().id}`; },
    get label() { return pick().label; },
    get aliases() { return ["antigravity", "agy", "gemini", pick().id, pick().label.toLowerCase()]; },
    renew,
    reset: () => {},
    async *run(input) {
      const proc = spare ?? spawnProc();
      spare = undefined;
      const kill = () => { void killTree(proc.p); };
      input.signal?.addEventListener("abort", kill, { once: true });
      const timer = setTimeout(kill, cfg.timeout_s * 1000);
      proc.p.stdin.write(JSON.stringify({ event: "user", message: { content: input.text } }) + "\n");
      const info: Record<string, unknown> = {};
      const seen = new Set<string>();
      let full = "", lastStep = -1;
      try {
        for (;;) {
          const ev = await proc.q.next();
          if (ev === null) { info.error ??= "processus terminé"; break; }
          if (ev.event === "step_update") {
            const s = ev.step_update ?? {};
            if (s.text_delta && s.step_type === "agent_response") {
              if (full && lastStep !== s.step_index) { full += " "; yield { type: "text", delta: " " } satisfies BrainEvent; }
              lastStep = s.step_index;
              full += s.text_delta;
              yield { type: "text", delta: String(s.text_delta) };
            } else if (s.tool_name && !seen.has(String(s.step_index))) {
              seen.add(String(s.step_index));
              const par = s.tool_info?.parameters ?? {};
              if (s.tool_name === "call_mcp_tool") yield { type: "tool", name: String(par.ToolName), args: par.Arguments ?? par };
              // Lire le schéma d'un outil MCP fait partie de l'appel MCP chez agy. Tout autre outil intégré est anormal.
              else if (!(s.tool_name === "view_file" && schemaRead(par.AbsolutePath))) ctx.audit.write({ kind: "cli.unexpected_tools", cli: "agy", tools: [String(s.tool_name)] });
            }
          } else if (ev.event === "result") {
            Object.assign(info, { status: ev.result?.status, error: ev.result?.error, denied_actions: ev.result?.denied_actions });
            break;
          }
        }
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", kill);
        proc.p.stdin.end();
        kill();
        if (!spare && ctx.alive) spare = spawnProc();
      }
      yield { type: "done", text: full.trim(), info };
    },
    stop: async () => { clearTimeout(refresh); spare = undefined; await Promise.all([...live].map((x) => killTree(x.p))); },
  };
}

export default definePlugin<Config>({
  manifest: {
    id: "brain-agy-cli",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "cerveau", label: { fr: "Cerveau", en: "Brain" } },
    ],
    description: "Antigravity (CLI agy de Google) comme cerveau ou pour la délégation, branché seulement sur le serveur MCP Floppy.",
    provides: ["delegate", "llm"],
    inject: ["mcp"],
    permissions: { exec: ["agy"], cloud: true },
    addable: { section: "cerveau", label: "Antigravity", description: { fr: "Ton compte Google, par le CLI Antigravity (Gemini). Cerveau ou délégué. Conditions de Google peu claires pour un outil tiers.", en: "Your Google account, through the Antigravity CLI (Gemini). Brain or delegate. Google's terms are unclear for third-party tools." }, cloud: true, single: true, aliases: ["antigravity", "agy", "gemini"] },
  },
  config: Config,
  apply(ctx, cfg) {
    const mcp = ctx.get("mcp");
    const exe = cfg.exe ?? findExe("agy");
    const find = (id: string) => cfg.models.find((m) => m.id === id);
    // Un seul élément dans la rubrique Cerveau. Son modèle se choisit dans sa page (formulaire) : gardé dans
    // <home>/items/<entrée>.json, appliqué à la demande suivante sans rien redémarrer.
    const store = ctx.items.store();
    const itemId = "antigravity";
    const T = (fr: string, en: string) => ({ fr, en });
    // Deux modèles : un pour le cerveau principal (« model »), un pour la délégation des tâches complexes (« delegateModel »).
    const pickOf = (key: "model" | "delegateModel", def: string) => () => {
      const id = String((store.data.edits[itemId] as Record<string, unknown> | undefined)?.[key] ?? def);
      return find(id) ?? { id, label: id };
    };
    const pick = pickOf("model", cfg.models[0]!.id);
    const pickDelegate = pickOf("delegateModel", (cfg.models[1] ?? cfg.models[0]!).id);
    const brains = new Set<{ renew(): void }>();
    const name = T("Antigravity", "Antigravity");
    ctx.items.declare({
      id: "agy-cli", section: "cerveau", order: 32, offers: ["llm", "delegate"],
      label: name,
      description: T("Ton compte Google, par le CLI Antigravity (Gemini). Aucune clé d'API.", "Your Google account, through the Antigravity CLI (Gemini). No API key."),
      badge: T("cloud", "cloud"),
      kinds: [{ id: "cli", label: name, fields: [
        { key: "model", label: T("Modèle du cerveau principal", "Main brain model"), type: "select", required: true,
          options: cfg.models.map((m) => ({ value: m.id, label: m.label })),
          hint: T("Quand il répond lui-même. S'applique à la demande suivante.", "When it answers itself. Applies from the next request.") },
        { key: "delegateModel", label: T("Modèle de délégation", "Delegation model"), type: "select", required: true,
          options: cfg.models.map((m) => ({ value: m.id, label: m.label })),
          hint: T("Pour les tâches complexes que le cerveau principal lui confie.", "For the complex tasks the main brain hands over.") },
      ] }],
      list: () => {
        const on = store.isEnabled(itemId);
        const m = pick();
        const d = pickDelegate();
        return [{
          id: itemId, kind: "cli", label: name, enabled: on, cloud: true, aliases: ["antigravity", "agy", "gemini", m.id], values: { model: m.id, delegateModel: d.id },
          detail: T(`principal : ${m.label} · délégation : ${d.label}`, `main: ${m.label} · delegation: ${d.label}`),
          status: !exe ? "warn" : on ? "ok" : "off",
          statusText: !exe ? T("programme agy introuvable : installe Antigravity", "agy program not found: install Antigravity")
            : on ? undefined : T("désactivé : plus proposé", "disabled: no longer offered"),
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
        return { ok: true, text: T(`Antigravity : ${m.label} en principal, ${d.label} en délégation.`, `Antigravity: ${m.label} as main, ${d.label} for delegation.`) };
      },
      setEnabled: async (id, on) => {
        if (id !== itemId) return { ok: false, text: T(`Élément inconnu : ${id}`, `Unknown item: ${id}`) };
        store.setEnabled(itemId, on);
        ctx.items.changed();
        return { ok: true, text: on ? T("Antigravity activé.", "Antigravity enabled.") : T("Antigravity désactivé (rien n'est supprimé).", "Antigravity disabled (nothing is deleted).") };
      },
    });
    const items = () => exe && store.isEnabled(itemId) ? [{ id: itemId, label: name, aliases: ["antigravity", "agy", "gemini"], cloud: true }] : [];
    /** Démarre l'agent dans son fork : ses processus vivent et meurent avec lui. */
    const brainIn = (f: Context, which: () => { id: string; label: string }) => {
      if (!exe) throw new Error("programme agy introuvable");
      const b = makeAgyBrain(f, cfg, mcp, exe, which);
      b.enabled = () => store.isEnabled(itemId);
      brains.add(b);
      f.effect(() => { brains.delete(b); return b.stop(); });
      return b;
    };
    ctx.offer("delegate", { items, start(f) { f.provide("delegate", brainIn(f, pickDelegate)); } });
    ctx.offer("llm", { items, start(f) {
      const b = brainIn(f, pick);
      f.provide("llm", { get label() { return b.label ?? "Antigravity"; }, get model() { return pick().id; }, cloud: true, agent: b });
    } });
  },
});
