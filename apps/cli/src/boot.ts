// Démarrage du noyau. Utilisé par `floppy start --headless` (Node 24) et par l'app Electron (utilityProcess).
import { copyFileSync, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { Kernel, FileAudit, consoleLogger, loadConfigFile, watchConfig, startControl, floppyHome, onboardingFor, type Logger, type Onboarding, type PluginDef } from "@floppy/core";
import { catalog } from "./catalog.ts";
import { createUserPlugins, settingKey, type ReloadItem, type UserPluginsOptions } from "./user-plugins.ts";
import { createPluginStore, type StoreOptions } from "./plugins/store.ts";
import { createWiki } from "./plugins/wiki.ts";
import { cliLang, sayer } from "./lang.ts";

export interface BootOptions {
  configPath: string;
  plugins?: PluginDef<any>[];
  logger?: Logger;
  watch?: boolean;
  /** Mode debug : dossiers de plugins chargés en plus, activés d'office, relus à chaque modification. */
  devDirs?: string[];
  /** Processus isolé des plugins tiers (Node, débogueur). */
  sandbox?: UserPluginsOptions["sandbox"];
  /** Relecteur des plugins tiers (tests) ; défaut : le service coder. */
  reviewer?: StoreOptions["reviewer"];
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

export async function boot(opts: BootOptions): Promise<Running> {
  const home = floppyHome();
  const configPath = resolve(opts.configPath);
  // Premier lancement : floppy.yml (propre à ce PC, hors git) est créé depuis floppy.example.yml.
  const example = join(dirname(configPath), "floppy.example.yml");
  const created = !existsSync(configPath) && existsSync(example);
  if (created) {
    copyFileSync(example, configPath);
    console.log(sayer(cliLang(home))(`config créée depuis ${example} : ${configPath}`, `config created from ${example}: ${configPath}`));
  }
  const kernel = new Kernel({
    plugins: opts.plugins ?? catalog,
    audit: new FileAudit(join(home, "audit.jsonl")),
    home,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  // Plugins de l'utilisateur : chargés avant la config, pour démarrer ceux qu'il a activés avec le reste.
  const log = opts.logger ?? consoleLogger;
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
  await kernel.applyConfig(loadConfigFile(configPath));
  const unwatch = opts.watch === false ? () => {} : watchConfig(configPath, kernel);
  const stopControl = await startControl(kernel, home, {
    reload: () => kernel.applyConfig(loadConfigFile(configPath)),
  });
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
    })()),
  };
}
