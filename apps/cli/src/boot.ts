// Démarrage du noyau. Utilisé par `floppy start --headless` (Node 24) et par l'app Electron (utilityProcess).
import { copyFileSync, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, FileAudit, consoleLogger, installSafetyNet, reapOrphans, loadConfigFile, watchConfig, startControl, floppyHome, applyPendingMove, defaultConfigPath, onboardingFor, type Logger, type Onboarding, type PluginDef } from "@floppy/core";
import { catalog } from "./catalog.ts";
import { createUserPlugins, settingKey, type ReloadItem, type UserPluginsOptions } from "./user-plugins.ts";
import { createPluginStore, type StoreOptions } from "./plugins/store.ts";
import { createWiki } from "./plugins/wiki.ts";
import { cliLang, sayer } from "./lang.ts";

/** Dossier de Floppy (le dépôt, ou l'app installée) : floppy.example.yml, et l'ancienne place de floppy.yml. */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface BootOptions {
  /** Config à lire. Défaut : <répertoire de travail>/floppy.yml (créée depuis floppy.example.yml). */
  configPath?: string;
  plugins?: PluginDef<any>[];
  logger?: Logger;
  watch?: boolean;
  /** Mode debug : dossiers de plugins chargés en plus, activés d'office, relus à chaque modification. */
  devDirs?: string[];
  /** Processus isolé des plugins tiers (Node, débogueur). */
  sandbox?: UserPluginsOptions["sandbox"];
  /** Relecteur des plugins tiers (tests) ; défaut : le service coder. */
  reviewer?: StoreOptions["reviewer"];
  /** Filet global du processus (défaut : installé). Les tests qui démarrent plusieurs noyaux le coupent. */
  safetyNet?: boolean;
  /** Arrête les programmes restés d'une session précédente (défaut : oui). */
  reapOrphans?: boolean;
}

/** Dossiers de debug passés par l'app de bureau (variable FLOPPY_DEV_PLUGINS, séparés comme le PATH). */
export function envDevDirs(): string[] {
  return (process.env.FLOPPY_DEV_PLUGINS ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean);
}

export interface Running {
  kernel: Kernel;
  home: string;
  /** Réglage de départ selon la machine (fenêtre « Bienvenue »). */
  onboarding: Onboarding;
  /** Premier lancement : la fenêtre « Bienvenue » doit s'ouvrir (config créée maintenant, ou réglage pas fini). */
  firstRun: boolean;
  /** Relit <home>/plugins : ajoute, recharge, signale les erreurs. */
  reloadUserPlugins(): Promise<ReloadItem[]>;
  stop(): Promise<void>;
}

export async function boot(opts: BootOptions = {}): Promise<Running> {
  // Nouveau répertoire de travail choisi à la dernière session : les données y sont déplacées avant tout le reste.
  applyPendingMove((m) => console.log(`[home] ${m}`));
  const home = floppyHome();
  // La config vit dans le répertoire de travail. Une ancienne config à la racine du dépôt y est copiée une fois.
  const configPath = resolve(opts.configPath ?? defaultConfigPath(home, [join(APP_ROOT, "floppy.yml")], (m) => console.log(`[home] ${m}`)));
  // Premier lancement : floppy.yml (propre à ce PC, hors git) est créé depuis floppy.example.yml.
  const example = [join(dirname(configPath), "floppy.example.yml"), join(APP_ROOT, "floppy.example.yml")].find((f) => existsSync(f)) ?? join(APP_ROOT, "floppy.example.yml");
  const created = !existsSync(configPath) && existsSync(example);
  if (created) {
    copyFileSync(example, configPath);
    console.log(sayer(cliLang(home))(`config créée depuis ${example} : ${configPath}`, `config created from ${example}: ${configPath}`));
  }
  // Programmes restés en vie après un arrêt forcé du noyau (llama-server, voix locale…) : ils gardent la mémoire du GPU.
  if (opts.reapOrphans !== false) {
    for (const r of await reapOrphans(join(home, "children.json")).catch(() => [])) {
      console.warn(`[kernel] programme resté d'une session précédente arrêté : ${r.name} (pid ${r.pid}, ${r.owner})`);
    }
  }
  const kernel = new Kernel({
    plugins: opts.plugins ?? catalog,
    audit: new FileAudit(join(home, "audit.jsonl")),
    home,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const log = opts.logger ?? consoleLogger;
  // Filet global : une erreur asynchrone oubliée par un plugin est écrite au journal, à son nom, au lieu de tuer le noyau.
  // Une exception non rattrapée met ce plugin en panne (il repart tout seul) ; sans plugin connu, elle est seulement notée.
  const offSafety = opts.safetyNet === false ? () => {} : installSafetyNet({
    onError: (kind, e) => {
      if (kernel.blame(kind, e)) return;
      log({ level: "error", source: "kernel", msg: `${kind} : ${e instanceof Error ? e.stack ?? e.message : String(e)}` });
    },
  });
  // Plugins de l'utilisateur : chargés avant la config, pour démarrer ceux qu'il a activés avec le reste.
  const devDirs = opts.devDirs ?? envDevDirs();
  const userPlugins = createUserPlugins(kernel, {
    builtin: (opts.plugins ?? catalog).map((p) => p.manifest.id), logger: log,
    ...(devDirs.length ? { devDirs } : {}),
    sandbox: { ...(process.env.FLOPPY_DEV_INSPECT === "1" ? { inspect: true } : {}), ...opts.sandbox },
  });
  const store = createPluginStore(kernel, { reload: () => userPlugins.reload(), enableKey: settingKey, logger: log, ...(opts.reviewer ? { reviewer: opts.reviewer } : {}) });
  // Wiki des plugins (outil doc_plugins) : pour l'assistant IA qui écrit un plugin depuis la fenêtre des réglages.
  const builtinManifests = (opts.plugins ?? catalog).map((p) => p.manifest);
  const offWiki = kernel.tools.register("plugins-wiki", [createWiki({ kernel, manifests: () => builtinManifests }).tool]);
  try { await userPlugins.reload(false); } catch (e) { log({ level: "error", source: "user-plugins", msg: String(e) }); }
  // Le point de contrôle s'ouvre avant la config : la CLI répond (`floppy status`) pendant qu'un modèle se charge.
  const stopControl = await startControl(kernel, home, {
    reload: () => kernel.applyConfig(loadConfigFile(configPath)),
  });
  try { await kernel.applyConfig(loadConfigFile(configPath)); } catch (e) { await stopControl(); offSafety(); throw e; }
  const unwatch = opts.watch === false ? () => {} : watchConfig(configPath, kernel);
  const onboarding = onboardingFor(kernel);
  if (created) onboarding.begin();
  // Floppy fermé pendant l'installation de départ : elle reprend (les blocs déjà téléchargés sont prêts tout de suite).
  void onboarding.resume().catch((e) => log({ level: "warn", source: "onboarding", msg: String(e) }));
  let stopping: Promise<void> | undefined;
  return {
    kernel,
    home,
    onboarding,
    firstRun: onboarding.needed(),
    reloadUserPlugins: () => userPlugins.reload(),
    stop: () => (stopping ??= (async () => {
      unwatch();
      store.dispose();
      void offWiki();
      userPlugins.dispose();
      await stopControl();
      await kernel.stopAll();
      offSafety();
    })()),
  };
}
