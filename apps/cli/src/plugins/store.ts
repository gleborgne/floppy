// Installation des plugins tiers : récupérer, contrôler, faire relire, puis installer sur un clic de l'utilisateur.
//
// 1. `installer_plugin` (outil, niveau write) : copie la source dans une quarantaine (<home>/plugins-pending/<id>),
//    lance les contrôles automatiques puis la revue par un agent IA. Aucun code du plugin n'est exécuté.
//    Sans agent de code (Claude Code, Codex, Antigravity), l'installation est refusée.
// 2. Un réglage par plugin en attente (`plugin_installer_<id>`, risque cli : clic ou CLI, jamais à la voix) montre le
//    rapport. Oui → le plugin est copié dans <home>/plugins/<id>, son empreinte va dans lock.json. Il reste désactivé.
// 3. L'activation est le réglage habituel `plugin_<id>` (user-plugins.ts). Le plugin tourne isolé (sandbox.ts).
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { T, TextError, tr, type CoderService, type Kernel, type Logger, type SettingDef, type ToolDef } from "@floppy/core";
import { checkPlugin, formatFindings, hashFiles, type CheckReport } from "./check.ts";
import { ID_RE } from "./format.ts";
import { readLock, writeLock, type LockEntry } from "./lock.ts";
import { parseReview, reportText, reviewPrompt, verdictText, type Review } from "./review.ts";
import { fetchSource, type FetchedSource, type FetchOptions } from "./source.ts";

export interface PendingReport {
  id: string;
  fetched: FetchedSource;
  check: Omit<CheckReport, "files"> & { files: number };
  review: Review;
  at: string;
}

/** Relecteur : rend la réponse brute d'un agent (service coder, ou faux relecteur dans les tests). */
export type Reviewer = (prompt: string, agent?: string, signal?: AbortSignal) => Promise<{ agent: string; text: string }>;

export interface StoreOptions {
  /** Relecteur ; défaut : le service `coder` du noyau. */
  reviewer?: Reviewer;
  /** Relit le dossier des plugins (user-plugins.reload). */
  reload: () => Promise<unknown>;
  /** Clé du réglage d'activation d'un plugin (user-plugins.settingKey). */
  enableKey: (id: string) => string;
  fetch?: FetchOptions;
  logger?: Logger;
}

export interface PluginStore {
  stage(source: string, signal?: AbortSignal): Promise<PendingReport>;
  pending(): PendingReport[];
  approve(id: string): Promise<LockEntry>;
  discard(id: string): void;
  remove(id: string): Promise<void>;
  dispose(): void;
}

export const pendingRoot = (home: string): string => join(home, "plugins-pending");
export const installKey = (id: string): string => "plugin_installer_" + id.replaceAll("-", "_");

/** Relecteur par défaut : le service `coder` (CLI de l'utilisateur). */
export function coderReviewer(kernel: Kernel): Reviewer {
  return async (prompt, agent, signal) => {
    const coder = kernel.service<CoderService>("coder");
    if (!coder?.review) {
      throw new TextError(T("Pour installer un plugin tiers, il faut l'assistant IA (Claude Code, Codex ou Antigravity) : active le plugin « coder ».",
        "To install a third-party plugin, the AI assistant is needed (Claude Code, Codex or Antigravity): turn on the \"coder\" plugin."));
    }
    return coder.review({ prompt, ...(agent && agent !== "auto" ? { agent } : {}), ...(signal ? { signal } : {}) });
  };
}

export function createPluginStore(kernel: Kernel, opts: StoreOptions): PluginStore {
  const home = kernel.home;
  const reviewer = opts.reviewer ?? coderReviewer(kernel);
  const lang = () => kernel.assistantSettings.language ?? "fr";
  let agent = kernel.settings.savedValue<string>("plugins_tiers_relecteur") ?? "auto";
  let offPending: () => void = () => {};
  let declared = "";

  const readReport = (id: string): PendingReport | undefined => {
    try { return JSON.parse(readFileSync(join(pendingRoot(home), id, "report.json"), "utf8")) as PendingReport; } catch { return undefined; }
  };
  const pending = (): PendingReport[] => {
    if (!existsSync(pendingRoot(home))) return [];
    return readdirSync(pendingRoot(home)).filter((d) => ID_RE.test(d)).map(readReport).filter((r): r is PendingReport => !!r);
  };

  function describe(r: PendingReport, l: string): string {
    const m = (fr: string, en: string) => (l === "en" ? en : fr);
    const blocked = !r.check.ok;
    const head = blocked ? m("Installation impossible : les contrôles automatiques ont bloqué ce plugin.", "Cannot install: the automatic checks blocked this plugin.")
      : r.review.verdict === "refus" ? m("Installation impossible : la revue a refusé ce plugin.", "Cannot install: the review refused this plugin.")
      : m("Clique pour l'installer (il restera désactivé).", "Click to install it (it stays turned off).");
    const perms = r.check.pkg?.permissions?.net?.length ? m(`Réseau : ${r.check.pkg.permissions.net.join(", ")}.`, `Network: ${r.check.pkg.permissions.net.join(", ")}.`) : m("Aucun accès réseau.", "No network access.");
    const lines = [
      head,
      `${r.check.pkg?.version ?? ""} — ${r.fetched.source}${r.fetched.commit ? ` @ ${r.fetched.commit.slice(0, 12)}` : ""}`,
      perms,
      m(`Revue (${r.review.agent}) : ${tr(verdictText(r.review.verdict), l)}.`, `Review (${r.review.agent}): ${tr(verdictText(r.review.verdict), l)}.`) + (r.review.summary ? " " + r.review.summary : ""),
      ...formatFindings(r.check.findings, l).slice(0, 8),
      ...r.review.findings.slice(0, 8).map((f) => `[${f.severity}] ${f.file ? `${f.file}${f.line ? ":" + f.line : ""} ` : ""}${f.text}`),
    ];
    return lines.join("\n");
  }

  function pendingSetting(r: PendingReport): SettingDef {
    return {
      key: installKey(r.id),
      label: T(`Installer « ${r.id} »`, `Install "${r.id}"`),
      get description() { return T(describe(r, "fr"), describe(r, "en")); },
      section: "plugins",
      group: T("Plugins tiers à installer", "Third-party plugins to install"),
      type: "boolean",
      risk: "cli",
      get: () => false,
      async set(v) { if (v === true) await approve(r.id); },
    };
  }

  function refresh(): void {
    const list = pending();
    const key = list.map((r) => `${r.id}@${r.at}`).sort().join(",");
    if (key === declared) return;
    declared = key;
    offPending();
    offPending = kernel.settings.declare("plugin-store", list.map(pendingSetting));
  }

  async function stage(source: string, signal?: AbortSignal): Promise<PendingReport> {
    const tmp = mkdtempSync(join(home, ".plugin-dl-"));
    try {
      const files = join(tmp, "files");
      const fetched = await fetchSource(source, files, opts.fetch);
      const check = checkPlugin(files);
      const id = check.pkg?.id;
      if (!id) throw new TextError(T(`plugin illisible :\n${formatFindings(check.findings, "fr").join("\n")}`, `plugin cannot be read:\n${formatFindings(check.findings, "en").join("\n")}`));
      const local = join(home, "plugins", id);
      if (existsSync(local) && !readLock(home)[id]) {
        throw new TextError(T(`un plugin personnel « ${id} » existe déjà dans ${local}`, `a personal plugin "${id}" already exists in ${local}`));
      }
      // Revue : obligatoire. Même un plugin bloqué est relu (le rapport aide l'auteur), sauf s'il est illisible.
      const res = await reviewer(reviewPrompt(files, check, lang()), agent, signal);
      const review = parseReview(res.text, res.agent);
      const report: PendingReport = { id, fetched, check: { ...check, files: check.files.length }, review, at: new Date().toISOString() };
      const dest = join(pendingRoot(home), id);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      renameSync(files, join(dest, "files"));
      writeFileSync(join(dest, "report.json"), JSON.stringify(report, null, 2), "utf8");
      kernel.audit.write({ kind: "plugin.staged", plugin: id, source: fetched.source, commit: fetched.commit, hash: check.hash, check: check.ok, verdict: review.verdict, agent: review.agent });
      refresh();
      return report;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function approve(id: string): Promise<LockEntry> {
    const r = readReport(id);
    if (!r) throw new TextError(T(`aucun plugin « ${id} » en attente`, `no pending plugin "${id}"`));
    if (!r.check.ok) throw new TextError(T("les contrôles automatiques ont bloqué ce plugin", "the automatic checks blocked this plugin"));
    if (r.review.verdict === "refus") throw new TextError(T("la revue a refusé ce plugin", "the review refused this plugin"));
    const files = join(pendingRoot(home), id, "files");
    const check = checkPlugin(files);
    if (check.hash !== r.check.hash) throw new TextError(T("les fichiers ont changé depuis la revue : relance l'installation", "the files changed since the review: start the installation again"));
    const dest = join(home, "plugins", id);
    const lock = readLock(home);
    if (existsSync(dest) && !lock[id]) throw new TextError(T(`un plugin personnel « ${id} » existe déjà`, `a personal plugin "${id}" already exists`));
    // Copie à côté, puis échange : jamais de plugin à moitié copié.
    const next = dest + ".new";
    rmSync(next, { recursive: true, force: true });
    cpSync(files, next, { recursive: true });
    if (hashFiles(next, check.files) !== r.check.hash) { rmSync(next, { recursive: true, force: true }); throw new TextError(T("copie incomplète", "incomplete copy")); }
    rmSync(dest, { recursive: true, force: true });
    renameSync(next, dest);
    const entry: LockEntry = {
      id, version: check.pkg!.version, source: r.fetched.source, kind: r.fetched.kind,
      ...(r.fetched.ref ? { ref: r.fetched.ref } : {}), ...(r.fetched.commit ? { commit: r.fetched.commit } : {}),
      hash: r.check.hash, installedAt: new Date().toISOString(),
      review: { verdict: r.review.verdict, agent: r.review.agent, at: r.review.at, summary: r.review.summary },
    };
    writeLock(home, { ...lock, [id]: entry });
    rmSync(join(pendingRoot(home), id), { recursive: true, force: true });
    kernel.audit.write({ kind: "plugin.installed", plugin: id, version: entry.version, source: entry.source, hash: entry.hash, verdict: entry.review.verdict });
    refresh();
    await opts.reload();
    return entry;
  }

  function discard(id: string): void {
    if (!ID_RE.test(id)) return;
    rmSync(join(pendingRoot(home), id), { recursive: true, force: true });
    refresh();
  }

  async function remove(id: string): Promise<void> {
    const lock = readLock(home);
    if (!ID_RE.test(id) || !lock[id]) throw new TextError(T(`aucun plugin tiers « ${id} » installé`, `no third-party plugin "${id}" installed`));
    // Désactivé d'abord : une réinstallation plus tard ne le rallume pas toute seule.
    try { await kernel.settings.change(opts.enableKey(id), false, "cli"); } catch { /* pas encore déclaré */ }
    rmSync(join(home, "plugins", id), { recursive: true, force: true });
    delete lock[id];
    writeLock(home, lock);
    kernel.audit.write({ kind: "plugin.removed", plugin: id });
    await opts.reload();
  }

  const offSettings = kernel.settings.declare("plugin-store", [{
    key: "plugins_tiers_relecteur",
    label: T("Relecteur des plugins tiers", "Third-party plugin reviewer"),
    description: T("L'agent de code qui relit un plugin tiers avant son installation. Automatique : le premier installé.",
      "The coding agent that reviews a third-party plugin before it is installed. Automatic: the first one installed."),
    section: "plugins",
    group: T("Plugins tiers", "Third-party plugins"),
    type: "enum",
    risk: "cli",
    options: [
      { value: "auto", label: T("Automatique", "Automatic"), aliases: ["auto", "automatique", "automatic"] },
      { value: "claude", label: "Claude Code", aliases: ["claude"] },
      { value: "codex", label: "Codex", aliases: ["codex"] },
      { value: "agy", label: "Antigravity", aliases: ["antigravity", "agy"] },
    ],
    get: () => agent,
    set: (v) => { agent = String(v); },
  }]);

  const tools: ToolDef[] = [
    {
      name: "installer_plugin",
      description: "Récupère un plugin tiers (dossier, archive .zip, adresse https://…zip ou dépôt git, avec #branche ou #commit), le contrôle, puis le fait relire par un agent IA. N'installe ni n'active rien : l'utilisateur décide ensuite d'un clic dans la fenêtre des réglages.",
      inputSchema: { type: "object", properties: { source: { type: "string", description: "chemin ou adresse du plugin" } }, required: ["source"] },
      // write : télécharge et lance un agent de code ; rien n'est exécuté du plugin.
      level: "write",
      summary: (a) => T(`Télécharger et faire relire le plugin ${String(a.source)} (rien n'est installé sans ton clic)`, `Download and review the plugin ${String(a.source)} (nothing is installed without your click)`),
      async handler(a, meta) {
        const r = await stage(String(a.source ?? ""), meta.signal);
        const blocked = !r.check.ok || r.review.verdict === "refus";
        const fr = `${reportText({ ...r.check, files: [] }, r.review, "fr")}\n\n${blocked ? "Ce plugin ne peut pas être installé." : `Pour l'installer : fenêtre des réglages, rubrique Plugins, « Installer « ${r.id} » » (ou : floppy plugin approve ${r.id}).`}`;
        const en = `${reportText({ ...r.check, files: [] }, r.review, "en")}\n\n${blocked ? "This plugin cannot be installed." : `To install it: Settings window, Plugins section, "Install "${r.id}"" (or: floppy plugin approve ${r.id}).`}`;
        return { status: blocked ? "failed" : "done", text: T(fr, en), raw: r };
      },
    },
    {
      name: "plugins_tiers",
      description: "Liste les plugins tiers installés (source, version, verdict de la revue) et ceux en attente d'installation.",
      inputSchema: { type: "object", properties: {} },
      level: "read",
      async handler() {
        const lock = Object.values(readLock(home));
        const wait = pending();
        const inst = lock.map((e) => `- ${e.id} ${e.version} — ${e.source}${e.commit ? " @ " + e.commit.slice(0, 12) : ""} — revue : ${e.review.verdict} (${e.review.agent})`);
        const instEn = lock.map((e) => `- ${e.id} ${e.version} — ${e.source}${e.commit ? " @ " + e.commit.slice(0, 12) : ""} — review: ${e.review.verdict} (${e.review.agent})`);
        const pend = wait.map((r) => `- ${r.id} ${r.check.pkg?.version ?? ""} — ${r.fetched.source} — ${r.check.ok ? "" : "BLOQUÉ, "}revue : ${r.review.verdict}`);
        const pendEn = wait.map((r) => `- ${r.id} ${r.check.pkg?.version ?? ""} — ${r.fetched.source} — ${r.check.ok ? "" : "BLOCKED, "}review: ${r.review.verdict}`);
        return {
          status: "done",
          text: T(`Installés :\n${inst.join("\n") || "(aucun)"}\n\nEn attente :\n${pend.join("\n") || "(aucun)"}`, `Installed:\n${instEn.join("\n") || "(none)"}\n\nPending:\n${pendEn.join("\n") || "(none)"}`),
          raw: { installed: lock, pending: wait.map((r) => r.id) },
        };
      },
    },
    {
      name: "desinstaller_plugin",
      description: "Désinstalle un plugin tiers : il est désactivé, ses fichiers sont supprimés. Retire aussi un plugin en attente d'installation.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      level: "delete",
      summary: (a) => T(`Désinstaller le plugin tiers « ${String(a.id)} »`, `Uninstall the third-party plugin "${String(a.id)}"`),
      async handler(a) {
        const id = String(a.id ?? "");
        if (readReport(id) && !readLock(home)[id]) { discard(id); return { status: "done", text: T(`« ${id} » retiré de l'attente.`, `"${id}" removed from the queue.`) }; }
        await remove(id);
        return { status: "done", text: T(`Plugin « ${id} » désinstallé.`, `Plugin "${id}" uninstalled.`) };
      },
    },
  ];
  const offTools = kernel.tools.register("plugin-store", tools);
  refresh();

  return { stage, pending, approve, discard, remove, dispose: () => { offTools(); offSettings(); offPending(); } };
}

