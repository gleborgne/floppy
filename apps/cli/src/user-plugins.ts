// Plugins de l'utilisateur : <home>/plugins/<id>/index.ts, ajoutés sans refaire l'app.
//
// Contrat d'un dossier :
// - `index.ts` exporte par défaut un objet simple { manifest, config?, apply(ctx, cfg) } (même forme que PluginDef).
// - Il n'a le droit d'utiliser que `import type` (effacé) : aucun paquet à l'exécution (ni @floppy/core, ni zod).
// - manifest.id = nom du dossier (lettres minuscules, chiffres, tirets) ; pas l'id d'un plugin livré avec l'app.
// - Les fichiers à la racine de <home>/plugins (floppy-plugin.d.ts, AGENTS.md…) et les dossiers sans index.ts sont ignorés.
//
// Activation : un réglage par plugin (`plugin_<id>`, risque cli : jamais à la voix, car le code n'est pas vérifié).
// Oui → entrée `u-<id>` ajoutée au noyau (setExtraEntries). Le choix est gardé par le registre des réglages.
//
// SÉCURITÉ : importer ou tester un plugin personnel EXÉCUTE son code avec tous les droits du processus.
// C'est pourquoi `reload_plugins` et `test_plugin` sont de niveau « write » (accord demandé par défaut).
//
// Plugin distribué (dossier avec floppy-plugin.json, voir plugins/format.ts) : jamais importé ici. Il tourne dans un
// processus Node isolé (plugins/sandbox.ts). S'il a été installé par la boutique (plugins/store.ts), son empreinte est
// dans lock.json et il ne démarre pas si ses fichiers ont changé depuis la revue.
//
// Mode debug (`floppy dev <dossier>`) : des dossiers hors de <home>/plugins, activés d'office et relus à chaque
// modification de fichier (watch).
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kernel, MemorySecrets, consoleLogger, manifestError, type EntryConfig, type Logger, type PluginDef, type SettingDef, type ToolDef, type Text, T, TextError, errorText, tr } from "@floppy/core";
import { hasPackage, readPackage } from "./plugins/format.ts";
import { readLock } from "./plugins/lock.ts";
import { sandboxedPlugin, type SandboxOptions } from "./plugins/sandbox.ts";

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** local : plugin personnel (importé) ; tiers : installé par la boutique (isolé, empreinte vérifiée) ;
 * paquet : dossier avec floppy-plugin.json copié à la main (isolé) ; dev : mode debug. */
export type UserPluginKind = "local" | "tiers" | "paquet" | "dev";

export interface UserPluginInfo {
  id: string;
  dir: string;
  kind: UserPluginKind;
  /** Description du manifeste (si le chargement a réussi). */
  description?: Text;
  /** Erreur du dernier chargement (le plugin chargé avant reste en place). */
  error?: string;
  /** Un plugin de ce nom est enregistré dans le noyau. */
  registered: boolean;
  enabled: boolean;
  /** Droits déclarés par le manifeste, en une phrase. */
  permissions?: string;
}

export interface ReloadItem {
  id: string;
  status: "ajouté" | "rechargé" | "inchangé" | "retiré" | "erreur";
  error?: string;
}

export interface TestReport {
  id: string;
  ok: boolean;
  state?: string;
  error?: string;
  missing: string[];
  tools: { name: string; level: string }[];
  settings: { key: string; label: string; risk: string }[];
  logs: string[];
  timedOut?: boolean;
}

export interface UserPlugins {
  /** Relit le dossier, réimporte, remplace ce qui a changé. Ne lève jamais pour un plugin cassé. */
  /** importAll = false : ne lit pas le code des plugins désactivés (démarrage). */
  reload(importAll?: boolean): Promise<ReloadItem[]>;
  list(): UserPluginInfo[];
  test(id: string): Promise<TestReport>;
  dispose(): void;
}

interface Slot {
  id: string;
  dir: string;
  kind: UserPluginKind;
  def?: PluginDef<any>;
  signature?: string;
  error?: string;
}

let importSeq = 0;

/** Importe un dossier de plugin et valide l'objet exporté. Lève une Error au texte clair. */
export async function importUserPlugin(dir: string, folder: string, builtin: ReadonlySet<string>): Promise<PluginDef<any>> {
  const file = join(dir, "index.ts");
  let mod: { default?: unknown };
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(file).href + "?v=" + Date.now() + String(importSeq++));
  } catch (e) {
    throw new Error(`import impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
  return validate(mod.default, folder, builtin);
}

function validate(x: unknown, folder: string, builtin: ReadonlySet<string>): PluginDef<any> {
  if (!x || typeof x !== "object") throw new Error("export par défaut manquant (un objet { manifest, apply } est attendu)");
  const d = x as Record<string, unknown>;
  const m = d.manifest as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") throw new Error("manifest manquant");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error("manifest.id : minuscules, chiffres et tirets, commence par une lettre");
  if (m.id !== folder) throw new Error(`manifest.id « ${m.id} » doit être égal au nom du dossier « ${folder} »`);
  if (builtin.has(m.id)) throw new Error(`l'id « ${m.id} » est pris par un plugin livré avec l'app`);
  if (typeof m.version !== "string" || !m.version) throw new Error("manifest.version manquant");
  if (typeof m.licence !== "string" || !m.licence) throw new Error("manifest.licence manquante");
  for (const k of ["provides", "inject", "optional"]) {
    const v = m[k];
    if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === "string"))) throw new Error(`manifest.${k} : liste de textes attendue`);
  }
  const bad = manifestError(m);
  if (bad) throw new Error(`manifeste invalide : ${bad}`);
  // Répondre aux accords est réservé aux corps (livrés avec l'app) : un plugin utilisateur ne s'accorde pas ses propres droits.
  if ((m.permissions as { approvals?: unknown } | undefined)?.approvals === "respond") {
    throw new Error("permissions.approvals: \"respond\" refusé : réservé aux corps livrés avec l'app, pas aux plugins utilisateur");
  }
  if (typeof d.apply !== "function") throw new Error("apply(ctx, cfg) manquant");
  if (d.config !== undefined && !(typeof d.config === "object" && d.config !== null && typeof (d.config as { safeParse?: unknown }).safeParse === "function")) {
    throw new Error("config : schéma avec safeParse attendu (ou rien : la config brute est passée)");
  }
  return d as unknown as PluginDef<any>;
}

/** Empreinte des fichiers d'un dossier (nom, date, taille) : détecte une modification. */
function signature(dir: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length > 300 || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + "/");
      else { const s = statSync(p); out.push(`${rel}${e.name}:${s.mtimeMs}:${s.size}`); }
    }
  };
  try { walk(dir, ""); } catch { /* dossier disparu */ }
  return out.join("|");
}

/** Droits déclarés par un manifeste, en une phrase (montrée avant l'activation). */
export function describePermissions(p: PluginDef["manifest"]["permissions"], lang = "fr"): string {
  const m = (fr: string, en: string) => (lang === "en" ? en : fr);
  const none = m("aucun droit déclaré", "no declared permissions");
  if (!p) return none;
  const parts: string[] = [];
  if (p.exec?.length) parts.push(m(`lance des programmes : ${p.exec.join(", ")}`, `runs programs: ${p.exec.join(", ")}`));
  if (p.net?.length) parts.push(m(`réseau : ${p.net.join(", ")}`, `network: ${p.net.join(", ")}`));
  if (p["fs.read"]?.length) parts.push(m(`lit : ${p["fs.read"].join(", ")}`, `reads: ${p["fs.read"].join(", ")}`));
  if (p["fs.write"]?.length) parts.push(m(`écrit : ${p["fs.write"].join(", ")}`, `writes: ${p["fs.write"].join(", ")}`));
  if (p.cloud) parts.push(m("envoie des données dans le cloud", "sends data to the cloud"));
  if (p.approvals) parts.push(m(`accords : ${p.approvals}`, `approvals: ${p.approvals}`));
  return parts.length ? parts.join(" ; ") : none;
}

/**
 * Essai d'un plugin dans un noyau jetable (10 s au plus) : état final, erreur, outils et réglages déclarés, journal.
 * Rien n'est gardé : dossier temporaire, coffre en mémoire.
 */
export async function throwawayTest(def: PluginDef<any>, id: string, rep: TestReport = { id, ok: false, missing: [], tools: [], settings: [], logs: [] }): Promise<TestReport> {
  const tmp = mkdtempSync(join(tmpdir(), "floppy-testplugin-"));
  const k = new Kernel({
    home: tmp,
    secrets: new MemorySecrets(), // jamais le trousseau de l'OS pour un essai jetable
    plugins: [def],
    logger: (r) => { rep.logs.push(`[${r.level}] ${r.source} : ${r.msg}${r.data ? " " + JSON.stringify(r.data) : ""}`.slice(0, 400)); },
  });
  const eid = "u-" + id;
  try {
    const done = k.applyConfig({ plugins: [{ id: eid, plugin: id, config: {} }] }).then(() => true);
    const ok = await Promise.race([done, new Promise<false>((r) => setTimeout(() => r(false), 10_000))]);
    if (!ok) { rep.timedOut = true; rep.error = "délai de 10 s dépassé (apply() ne finit pas)"; }
    const st = k.status().find((s) => s.id === eid);
    rep.state = st?.state;
    if (st?.error && !rep.error) rep.error = tr(st.error);
    rep.missing = st?.missing ?? [];
    rep.tools = k.tools.list().filter((t) => t.source === eid).map((t) => ({ name: t.name, level: t.level }));
    rep.settings = k.settings.list().filter((s) => s.source === eid).map((s) => ({ key: s.key, label: tr(s.label), risk: s.risk }));
    rep.ok = !rep.error && (st?.state === "active" || st?.state === "waiting");
  } catch (e) {
    rep.error = errText(e);
  } finally {
    await Promise.race([k.stopAll(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fichier encore ouvert : sans gravité */ }
  }
  return rep;
}

/** Charge un dossier de plugin hors de Floppy (CLI `floppy plugin test`) : isolé s'il a un floppy-plugin.json. */
export async function loadPluginDir(dir: string, sandbox: UserPluginsOptions["sandbox"] = {}): Promise<{ id: string; def: PluginDef<any> }> {
  const abs = resolve(dir);
  if (hasPackage(abs)) {
    const pkg = readPackage(abs);
    return { id: pkg.id, def: sandboxedPlugin({ dir: abs, pkg, ...sandbox }) };
  }
  const id = basename(abs);
  return { id, def: await importUserPlugin(abs, id, new Set()) };
}

export function settingKey(id: string): string {
  return "plugin_" + id.replaceAll("-", "_");
}

const errText = (e: unknown) => tr(errorText(e));

export interface UserPluginsOptions {
  builtin: Iterable<string>;
  logger?: Logger;
  /** Mode debug : dossiers de plugins hors de <home>/plugins, activés d'office et surveillés. */
  devDirs?: string[];
  /** Réglages du processus isolé (Node, débogueur, délais, fetch des tests). */
  sandbox?: Partial<Pick<SandboxOptions, "node" | "inspect" | "timeouts" | "fetch">>;
}

export function createUserPlugins(kernel: Kernel, opts: UserPluginsOptions): UserPlugins {
  const builtin = new Set(opts.builtin);
  const logger = opts.logger ?? consoleLogger;
  const root = join(kernel.home, "plugins");
  const slots = new Map<string, Slot>();
  const enabled = new Map<string, boolean>();
  let offSettings: () => void = () => {};
  let declaredKeys = "";
  let chain: Promise<unknown> = Promise.resolve();
  const devDirs = (opts.devDirs ?? []).map((d) => resolve(d));
  const watchers: FSWatcher[] = [];

  /** Définition d'un plugin : isolée s'il a un floppy-plugin.json, importée sinon (plugin personnel). */
  async function loadDef(slot: Slot): Promise<PluginDef<any>> {
    if (hasPackage(slot.dir)) {
      const pkg = readPackage(slot.dir);
      if (pkg.id !== slot.id) throw new Error(`l'id « ${pkg.id} » (floppy-plugin.json) doit être égal au nom du dossier « ${slot.id} »`);
      if (builtin.has(pkg.id)) throw new Error(`l'id « ${pkg.id} » est pris par un plugin livré avec l'app`);
      const lock = slot.kind === "dev" ? undefined : readLock(kernel.home)[pkg.id];
      return sandboxedPlugin({ dir: slot.dir, pkg, ...(lock ? { expectHash: lock.hash } : {}), ...opts.sandbox });
    }
    return importUserPlugin(slot.dir, slot.id, builtin);
  }

  function kindOf(dir: string, id: string): UserPluginKind {
    if (!hasPackage(dir)) return "local";
    return readLock(kernel.home)[id] ? "tiers" : "paquet";
  }

  const entries = (): EntryConfig[] =>
    [...slots.values()].filter((s) => s.def && enabled.get(s.id)).map((s) => ({ id: "u-" + s.id, plugin: s.id, config: {}, disabled: false }));

  const stateOf = (id: string, lang: string): string => kernel.status().find((s) => s.id === "u-" + id)?.state ?? (lang === "en" ? "stopped" : "arrêté");

  function describe(s: Slot, lang: string): string {
    const m = (fr: string, en: string) => (lang === "en" ? en : fr);
    const base = s.def?.manifest.description ? s.def.manifest.description + " " : "";
    const lock = s.kind === "tiers" ? readLock(kernel.home)[s.id] : undefined;
    const origin = s.kind === "dev" ? m("Mode debug, dossier ", "Debug mode, folder ") + s.dir + ". "
      : lock ? m(`Plugin tiers ${lock.version}, de ${lock.source}${lock.commit ? " @ " + lock.commit.slice(0, 12) : ""} ; revue (${lock.review.agent}) : ${lock.review.verdict}. Il tourne isolé. `,
        `Third-party plugin ${lock.version}, from ${lock.source}${lock.commit ? " @ " + lock.commit.slice(0, 12) : ""}; review (${lock.review.agent}): ${lock.review.verdict}. It runs isolated. `)
      : s.kind === "paquet" ? m("Plugin distribué copié à la main (non relu). Il tourne isolé. ", "Packaged plugin copied by hand (not reviewed). It runs isolated. ") : "";
    const load = s.error ? m(`Chargement : erreur : ${s.error}`, `Loading: error: ${s.error}`)
      : s.def ? m("Chargement : chargé", "Loading: loaded") : m("Pas encore lu : il sera lu quand tu l'activeras", "Not read yet: it will be read when you turn it on");
    const perms = s.def ? m(` Droits déclarés : ${describePermissions(s.def.manifest.permissions, lang)}.`, ` Declared permissions: ${describePermissions(s.def.manifest.permissions, lang)}.`) : "";
    const state = enabled.get(s.id) ? m(" ; état : ", "; state: ") + stateOf(s.id, lang) : "";
    if (s.kind !== "local") return m(`${base}(${origin}${perms.trim()} ${load}${state}.)`, `${base}(${origin}${perms.trim()} ${load}${state}.)`);
    return m(`${base}(Plugin de l'utilisateur, code non vérifié.${perms} ${load}${state}.)`, `${base}(User plugin, unverified code.${perms} ${load}${state}.)`);
  }

  function settingFor(s: Slot): SettingDef {
    return {
      key: settingKey(s.id),
      label: T(`Plugin « ${s.id} »`, `Plugin "${s.id}"`),
      get description() { return T(describe(s, "fr"), describe(s, "en")); },
      section: "plugins",
      group: T("Plugins utilisateur", "User plugins"),
      type: "boolean",
      risk: "cli",
      get: () => enabled.get(s.id) ?? false,
      async set(v) {
        const on = v === true || s.kind === "dev"; // mode debug : toujours actif
        // Pas encore lu (désactivé au démarrage) : on le lit maintenant, le clic d'activation vaut accord.
        if (on && !s.def && !s.error) {
          try {
            s.def = await loadDef(s);
            await kernel.replacePlugin(s.def);
          } catch (e) { s.error = errText(e); }
        }
        if (on && !s.def) throw new TextError(T(`plugin en erreur : ${s.error ?? "non chargé"}`, `plugin error: ${s.error ?? "not loaded"}`));
        enabled.set(s.id, on);
        await kernel.setExtraEntries(entries());
      },
    };
  }

  function refreshSettings(): void {
    const ids = [...slots.values()].filter((s) => ID_RE.test(s.id)).map((s) => s.id).sort();
    const key = ids.join(",");
    if (key === declaredKeys) return;
    declaredKeys = key;
    offSettings();
    offSettings = kernel.settings.declare("user-plugins", ids.map((id) => settingFor(slots.get(id)!)));
  }

  /** importAll = false (démarrage) : un plugin désactivé n'est PAS importé (importer exécute son code). */
  async function doReload(importAll = false): Promise<ReloadItem[]> {
    const report: ReloadItem[] = [];
    const found: { id: string; dir: string; kind: UserPluginKind }[] = [];
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || !existsSync(join(root, e.name, "index.ts"))) continue;
        found.push({ id: e.name, dir: join(root, e.name), kind: kindOf(join(root, e.name), e.name) });
      }
    } catch { /* pas de dossier plugins : rien à charger */ }
    for (const dir of devDirs) {
      let id = basename(dir);
      try { if (hasPackage(dir)) id = readPackage(dir).id; } catch { /* erreur montrée au chargement */ }
      const i = found.findIndex((f) => f.id === id);
      if (i >= 0) found.splice(i, 1); // le dossier de debug remplace un plugin installé du même nom
      found.push({ id, dir, kind: "dev" });
    }
    found.sort((a, b) => a.id.localeCompare(b.id));
    const folders = found.map((f) => f.id);

    for (const { id, dir, kind } of found) {
      const sig = signature(dir) + "|" + kind + "|" + dir;
      let slot = slots.get(id);
      if (slot && slot.signature === sig) { report.push({ id, status: "inchangé", ...(slot.error ? { error: slot.error } : {}) }); continue; }
      const isNew = !slot?.def;
      if (!slot) { slot = { id, dir, kind }; slots.set(id, slot); }
      slot.dir = dir;
      slot.kind = kind;
      slot.signature = sig;
      if (kind === "dev") enabled.set(id, true);
      else if (!enabled.has(id)) enabled.set(id, kernel.settings.savedValue(settingKey(id)) === true);
      if (!importAll && !enabled.get(id)) {
        slot.signature = undefined; // pas lu : il le sera à l'activation (clic) ou au rechargement demandé
        report.push({ id, status: "inchangé" });
        continue;
      }
      try {
        const def = await loadDef(slot);
        delete slot.error;
        slot.def = def;
        await kernel.replacePlugin(def);
        report.push({ id, status: isNew ? "ajouté" : "rechargé" });
        logger({ level: "info", source: "user-plugins", msg: `${isNew ? "ajouté" : "rechargé"} : ${id}` });
      } catch (e) {
        slot.error = errText(e);
        report.push({ id, status: "erreur", error: slot.error });
        logger({ level: "warn", source: "user-plugins", msg: `${id} : ${slot.error}` });
      }
    }
    for (const id of [...slots.keys()]) {
      if (folders.includes(id)) continue;
      slots.delete(id);
      enabled.delete(id);
      report.push({ id, status: "retiré" });
    }
    refreshSettings();
    await kernel.setExtraEntries(entries());
    return report;
  }

  async function test(id: string): Promise<TestReport> {
    const rep: TestReport = { id, ok: false, missing: [], tools: [], settings: [], logs: [] };
    const known = slots.get(id);
    const slot: Slot | undefined = known ?? (ID_RE.test(id) && existsSync(join(root, id, "index.ts")) ? { id, dir: join(root, id), kind: kindOf(join(root, id), id) } : undefined);
    if (!slot) { rep.error = `aucun plugin « ${id} » dans ${root}`; return rep; }
    return testDef(slot, rep);
  }

  async function testDef(slot: Slot, rep: TestReport): Promise<TestReport> {
    let def: PluginDef<any>;
    try { def = await loadDef(slot); } catch (e) { rep.error = errText(e); return rep; }
    return throwawayTest(def, slot.id, rep);
  }

  const reload = (importAll = true): Promise<ReloadItem[]> => {
    const go = () => doReload(importAll);
    const run = chain.then(go, go);
    chain = run.catch(() => {});
    return run;
  };

  const tools: ToolDef[] = [
    {
      name: "plugin_status",
      description: "Liste les plugins (livrés avec l'app et ajoutés par l'utilisateur) avec leur état, les erreurs de chargement des plugins utilisateur et s'ils sont activés.",
      inputSchema: { type: "object", properties: {} },
      level: "read",
      async handler() {
        const st = kernel.status();
        const lines = st.filter((s) => !s.id.startsWith("u-")).map((s) => `- ${s.id} (${s.plugin}) : ${s.state}${s.error ? " — " + s.error : ""}${s.missing?.length ? " — attend " + s.missing.join(", ") : ""}`);
        const users = [...slots.values()].map((s) => {
          const e = st.find((x) => x.id === "u-" + s.id);
          return `- ${s.id} : ${s.error ? "erreur : " + s.error : "chargé"} ; ${enabled.get(s.id) ? "activé" : "désactivé"}${s.def ? " ; droits : " + describePermissions(s.def.manifest.permissions) : ""}${e ? ` ; état ${e.state}${e.error ? " — " + e.error : ""}` : ""}`;
        });
        return { status: "done", text: `Plugins livrés :\n${lines.join("\n") || "(aucun)"}\n\nPlugins utilisateur (${root}) :\n${users.join("\n") || "(aucun)"}` };
      },
    },
    {
      name: "reload_plugins",
      description: "Relit le dossier des plugins utilisateur après une modification de fichiers : ajoute les nouveaux, recharge ceux qui ont changé, signale les erreurs. Un plugin n'est jamais activé par cet outil (c'est un réglage).",
      inputSchema: { type: "object", properties: {} },
      // « write », pas « read » : importer un plugin exécute son code (accès complet à la machine).
      level: "write",
      summary: () => T("Recharger les plugins utilisateur (exécute leur code)", "Reload user plugins (runs their code)"),
      async handler() {
        const r = await reload();
        return { status: r.some((x) => x.status === "erreur") ? "unverified" : "done", text: r.length ? r.map((x) => `${x.id} : ${x.status === "erreur" ? "erreur : " + x.error : x.status}`).join("\n") : T("Aucun plugin utilisateur.", "No user plugins.") };
      },
    },
    {
      name: "test_plugin",
      description: "Essaie un plugin utilisateur dans un noyau jetable, sans toucher à l'assistant : état final, erreur, services manquants, outils et réglages déclarés, journal. Durée maximale 10 s.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "id du plugin (nom du dossier)" } }, required: ["id"] },
      // « write » : apply() est exécuté pour de vrai (processus, fichiers, réseau possibles).
      level: "write",
      summary: (a) => T(`Tester le plugin « ${String(a.id)} » (exécute son code)`, `Test the plugin "${String(a.id)}" (runs its code)`),
      async handler(a) {
        const r = await test(String(a.id ?? ""));
        const text = [
          `Plugin ${r.id} : ${r.ok ? "OK" : "PROBLÈME"}${r.state ? ` (état ${r.state})` : ""}`,
          ...(r.error ? [`Erreur : ${r.error}`] : []),
          ...(r.missing.length ? [`Services manquants (attente) : ${r.missing.join(", ")}`] : []),
          `Outils : ${r.tools.map((t) => `${t.name} [${t.level}]`).join(", ") || "aucun"}`,
          `Réglages : ${r.settings.map((s) => `${s.key} [${s.risk}]`).join(", ") || "aucun"}`,
          ...(r.logs.length ? ["Journal :", ...r.logs.slice(0, 40)] : []),
        ].join("\n");
        return { status: r.ok ? "done" : "failed", text, raw: r };
      },
    },
  ];
  const offTools = kernel.tools.register("user-plugins", tools);

  // Mode debug : chaque modification de fichier relit le plugin (après un court calme : un éditeur écrit en plusieurs fois).
  for (const dir of devDirs) {
    let timer: NodeJS.Timeout | undefined;
    try {
      watchers.push(watch(dir, { recursive: true }, (_ev, file) => {
        if (file && /(^|[\\/])(\.floppy-dev|node_modules|\.git)([\\/]|$)/.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void reload(true).then((r) => {
            for (const x of r) if (x.status !== "inchangé") logger({ level: x.status === "erreur" ? "warn" : "info", source: "dev", msg: `${x.id} : ${x.status}${x.error ? " — " + x.error : ""}` });
          });
        }, 250);
      }));
    } catch (e) { logger({ level: "warn", source: "dev", msg: `surveillance impossible de ${dir} : ${errText(e)}` }); }
  }

  return {
    reload,
    test,
    list: () => [...slots.values()].map((s) => ({
      id: s.id, dir: s.dir, kind: s.kind, registered: !!s.def, enabled: enabled.get(s.id) ?? false,
      ...(s.def ? { permissions: describePermissions(s.def.manifest.permissions) } : {}),
      ...(s.def?.manifest.description ? { description: s.def.manifest.description } : {}), ...(s.error ? { error: s.error } : {}),
    })),
    dispose: () => { for (const w of watchers.splice(0)) w.close(); offSettings(); offTools(); },
  };
}
