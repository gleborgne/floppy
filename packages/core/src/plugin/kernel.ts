// Le noyau : registre des plugins, table des services, cycle de vie.
//
// Règles :
// - Une entrée démarre quand tous ses services `inject` ont un fournisseur actif.
// - Un service est visible seulement après la fin de apply() de son fournisseur.
// - Arrêter un fournisseur arrête d'abord ses dépendants. Ils redémarrent dès qu'un fournisseur revient.
// - Si le fournisseur choisi d'un service change, ses dépendants redémarrent sur le nouveau.
// - Toutes les opérations passent par une file : jamais deux changements d'état en même temps.
// Règles « à la demande » (comme Cordis : ce qui ne sert à personne ne tourne pas) :
// - Un plugin `lazy` démarre seulement quand un plugin actif en a besoin (inject, ctx.use), et s'arrête quand plus personne ne s'en sert.
// - Un plugin peut offrir un service élément par élément (ctx.offer) : chaque élément tourne dans un « fork » (son propre scope d'effets).
// - Un slot (manifest.slots) choisit un élément. Le fork de l'élément choisi démarre quand son consommateur démarre (ctx.slot),
//   et s'arrête quand plus personne ne s'en sert. Changer le choix redémarre le consommateur sur le nouvel élément.
// - Aucun plugin n'allume ni n'éteint un autre plugin : seul le noyau le fait, d'après les besoins déclarés.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import { Bus, type PluginState } from "../bus.ts";
import { Hooks } from "./hooks.ts";
import { EffectScope } from "./effects.ts";
import { manifestError, type Manifest, type PluginDef, type SlotDef } from "./manifest.ts";
import type { LogLevel, OfferDef } from "./context.ts";
import type { SettingOption } from "../settings.ts";
import { ApprovalManager } from "../approval.ts";
import { MemoryAudit, type Audit } from "../audit.ts";
import { ToolRegistry } from "../tools.ts";
import { SettingsRegistry } from "../settings.ts";
import { SectionRegistry } from "../sections.ts";
import { settingsTools } from "../settings-tools.ts";
import { CatalogRegistry } from "../catalog.ts";
import { catalogTools } from "../catalog-tools.ts";
import { type Logo } from "../logo.ts";
import { defaultSecrets, MemorySecrets, type Secrets } from "../secrets.ts";
import { errorText, T, TextError, tr, type Text } from "../i18n.ts";
import { Apps } from "../apps.ts";
import { TaskRegistry, taskTools } from "../tasks.ts";
import { DownloadManager, type DownloadManagerOptions } from "../downloads.ts";
import type { DocumentsService, TaskService } from "../services.ts";
import { KernelConfig, type EntryConfig, type KernelConfigInput, type AssistantSettings } from "../config/schema.ts";
import { findExe, stableStringify } from "../util/process.ts";
import { ChildRegistry } from "../util/children.ts";
import { Deadline, offerItems, sameEntry } from "./lifecycle-util.ts";
import { makeContext } from "./context-factory.ts";
import type { KernelInternals } from "./kernel-internals.ts";
import { declareCoreSettings } from "./core-settings.ts";
import { declareSlots, declareServiceSelection } from "./selection-settings.ts";
import { probeMachine, type MachineInfo, type ProbeOptions } from "../machine.ts";

export type Logger = (rec: { level: LogLevel; source: string; msg: string; data?: Record<string, unknown> }) => void;

export const consoleLogger: Logger = ({ level, source, msg, data }) => {
  if (level === "debug" && !process.env.FLOPPY_DEBUG) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
};

/** Une entrée de la config (ou un fork) : son plugin, son état, ce qu'elle fournit. Interne au noyau. */
export interface Entry {
  cfg: EntryConfig;
  def?: PluginDef<any>;
  parsed?: unknown;
  state: PluginState;
  /** Erreur visible (français et anglais) ; montrée dans la langue de l'interface (status, plugin.state). */
  error?: Text;
  /** Raison donnée à ctx.fail() pendant apply : l'erreur est posée une seule fois, par startEntry. */
  failReason?: Text;
  missing?: string[];
  scope?: EffectScope;
  /** Services fournis, visibles des autres seulement quand state = active. */
  provided: Map<string, unknown>;
  /** Fournisseur utilisé pour chaque service injecté (au démarrage) ou demandé (ctx.use). */
  bound: Map<string, string | undefined>;
  /** Services demandés pendant apply (ctx.use) : besoin fort, comme inject. */
  used: Set<string>;
  /** Slots lus pendant apply (ctx.slot) : id du slot → clé du fork utilisé. */
  slotBound: Map<string, string | undefined>;
  /** Services offerts élément par élément (ctx.offer), le temps que l'entrée est active. */
  offers: Map<string, OfferDef<any>>;
  /** Fork : un élément offert par une autre entrée. */
  fork?: { parent: string; service: string; item: string };
  /** Ordre de démarrage (le plus ancien fork part d'abord quand `max` est atteint). */
  startedAt?: number;
  /** Délai du démarrage en cours (mis en pause pendant ctx.use et ctx.slot). */
  deadline?: Deadline;
  /** Fermeture en cours (ctx.fail ou délai pendant le démarrage) : attendue avant de poser l'erreur. */
  disposing?: Promise<Error[]>;
  /** Panne du plugin : comme ctx.fail (pour le filet global, qui ne connaît que l'id). */
  fail?: (reason: Text) => void;
  /** Reprise automatique après une panne : nombre d'essais faits, minuterie en cours. */
  retries: number;
  retryTimer?: NodeJS.Timeout;
  /** Heure à laquelle l'entrée est devenue active (une panne après une longue marche remet les essais à zéro). */
  activeAt?: number;
  /** Démarrage annulé exprès (nouveau choix, arrêt) : pas de reprise automatique. */
  cancelled?: boolean;
}

export interface EntryStatus {
  id: string;
  plugin: string;
  state: PluginState;
  provides: string[];
  error?: string;
  missing?: string[];
  /** Démarré seulement à la demande. */
  lazy?: boolean;
  /** Fork : élément offert par l'entrée `parent`. */
  fork?: { parent: string; service: string; item: string };
}

/** État d'un slot, pour la fenêtre des réglages. */
export interface SlotStatus {
  id: string;
  service: string;
  section: string;
  label: Text;
  description?: Text;
  none?: Text;
  display?: "mode" | "tabs";
  /** Place dans la chaîne de la rubrique (voir SlotDef.step). */
  step?: number;
  /** Plugin qui déclare le slot (le consommateur). */
  owner: string;
  /** "<entrée>/<élément>" ou "@none". */
  value: string;
  /**
   * État du fork choisi : active, starting, error… « idle » : choisi, mais personne ne s'en sert en ce moment (en veille).
   * « none » : rien de choisi, ou élément indisponible.
   */
  state: PluginState | "idle" | "none";
  error?: string;
}

export interface KernelOptions {
  plugins?: PluginDef<any>[];
  audit?: Audit;
  logger?: Logger;
  /** Dossier de données (défaut : dossier temporaire du système, pour les tests). */
  home?: string;
  /** Coffre des secrets (défaut : trousseau de l'OS si home est donné, sinon mémoire). */
  secrets?: Secrets;
  /** Téléchargements (tests : un fetch simulé). Défaut : fetch global, 2 en même temps. */
  downloads?: DownloadManagerOptions;
  /** Lecture de la machine (tests : sorties simulées). Défaut : les vraies sondes. */
  machine?: ProbeOptions;
  /** Délai par défaut de apply (défaut : 60 s ; manifest.startTimeout_s le remplace). */
  startTimeoutMs?: number;
  /** Délai d'une fermeture (défaut : 10 s). */
  disposeTimeoutMs?: number;
  /** Attentes avant chaque reprise automatique d'une entrée en panne (défaut : 5 s, 30 s, 2 min ; puis abandon visible). */
  retryDelays?: number[];
  /** Paquets de plugins qui n'ont pas pu se charger (dit dans l'erreur d'une entrée dont le plugin manque). */
  unloaded?: { pkg: string; error: string }[];
  /** Canal vers l'hôte (app de bureau), donné aux plugins par ctx.host. */
  host?: import("./context.ts").HostChannel;
}

export class Kernel {
  readonly bus = new Bus();
  readonly hooks = new Hooks();
  readonly audit: Audit;
  readonly approvals: ApprovalManager;
  readonly tools: ToolRegistry;
  readonly settings: SettingsRegistry;
  /** Rubriques de la fenêtre des réglages (déclarées par le noyau et les plugins). */
  readonly sections = new SectionRegistry();
  private readonly sectionOffs = new Map<string, () => void>();
  /** Éléments montrés dans la fenêtre des réglages (modèles, voix, connecteurs, corps, avatars). */
  readonly items: CatalogRegistry;
  readonly secrets: Secrets;
  readonly home: string;
  /** Programmes lancés par ctx.spawn (arrêtés au démarrage suivant si le noyau a été tué de force). */
  readonly children: ChildRegistry;
  /** Téléchargements de fichiers des plugins (modèles, voix) : une seule file pour tout le noyau. */
  readonly downloads: DownloadManager;
  /** Dossier où les plugins rangent les fichiers téléchargés (toujours <home>/models). */
  modelsDir: string;
  /** Indice de l'appli pour la lecture de la machine (fabricants des puces vues par le navigateur). */
  machineHint: ProbeOptions["hint"];
  private readonly machineOpts: ProbeOptions;
  private machineCache: { at: number; info: Promise<MachineInfo> } | undefined;
  /** Langue de la fenêtre des réglages et des menus (fr, en). */
  uiLang = "fr";
  /** Langue de l'assistant choisie dans les réglages (sinon celle de floppy.yml : assistant.language). */
  private assistantLang?: string;
  private readonly logger: Logger;
  /** Entrée dont le code tourne (apply, minuteries, écouteurs, outils) : le filet global sait à qui est une erreur. */
  private readonly als = new AsyncLocalStorage<string>();
  private readonly startTimeoutMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly retryDelays: number[];
  /** Emprunteurs d'un fork (ctx.borrow) : prévenus quand il s'arrête. Clé du fork → fonctions. */
  private readonly borrowers = new Map<string, Set<() => void>>();
  private readonly unloaded: { pkg: string; error: string }[];
  private readonly host: import("./context.ts").HostChannel | undefined;
  private stopped = false;
  private readonly catalog = new Map<string, PluginDef<any>>();
  /** Plugins dont le manifeste est invalide : id → raison. Leurs entrées démarrent en erreur visible. */
  private readonly invalid = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private selection: Record<string, string> = {};
  private readonly selectable = new Map<string, NonNullable<PluginDef["manifest"]["serviceSelection"]>>();
  private readonly selectionEdits = new Map<string, string>();
  /** Forks en cours (clé "<entrée>/<service>/<élément>"). */
  private forks = new Map<string, Entry>();
  private readonly slotDefs = new Map<string, { def: SlotDef; owner: string }>();
  /** Choix de départ des slots (floppy.yml), tant que l'utilisateur n'a rien choisi. */
  private slotDefaults: Record<string, string> = {};
  /** Entrées en cours de démarrage à la demande (garde contre les boucles de dépendances). */
  private readonly ensuring = new Set<string>();
  private seq = 0;
  private assistant: AssistantSettings;
  private queue: Promise<unknown> = Promise.resolve();
  /** Dernière config du fichier (sans les entrées en plus). */
  private baseCfg?: KernelConfig;
  /** Entrées ajoutées par l'hôte (plugins utilisateur), en plus de la config du fichier. */
  private extraEntries: EntryConfig[] = [];
  /** Choix de l'utilisateur sur les entrées du fichier (applications ajoutées, retirées, éteintes). */
  private transform: (base: EntryConfig[]) => EntryConfig[] = (b) => b;
  private notes = new Map<string, { text: Text; tone?: "ok" | "warn" | "error" }>();
  /** Logos donnés par ctx.items.logo, par entrée. */
  private logos = new Map<string, Logo | null>();
  private appActions = new Map<string, { list: { id: string; label: Text }[]; run: (a: string) => Promise<import("../catalog.ts").OpResult> }>();
  private apps?: Apps;
  /** Tâches des manifestes (veille…), lancées par le noyau (voir tasks.ts). */
  readonly tasks: TaskRegistry;
  /** Entrées et forks gardés en marche par le noyau le temps d'un travail (tâche, emprunt de slot) : clé → nombre. */
  private readonly holds = new Map<string, number>();

  constructor(opts: KernelOptions = {}) {
    const base = KernelConfig.parse({});
    this.assistant = base.assistant;
    this.audit = opts.audit ?? new MemoryAudit();
    // Sans dossier imposé (tests) : un dossier temporaire neuf par noyau, pour ne jamais mélanger les réglages.
    this.home = opts.home ?? mkdtempSync(join(tmpdir(), "floppy-kernel-"));
    this.logger = opts.logger ?? consoleLogger;
    this.startTimeoutMs = opts.startTimeoutMs ?? 60_000;
    this.disposeTimeoutMs = opts.disposeTimeoutMs ?? 10_000;
    this.retryDelays = opts.retryDelays ?? [5_000, 30_000, 120_000];
    this.unloaded = opts.unloaded ?? [];
    this.host = opts.host;
    this.hooks.onError = (owner, name, err) => this.log("error", owner ?? "hooks", `middleware ${name} : erreur après la suite, son résultat est gardé : ${err instanceof Error ? err.message : String(err)}`);
    this.children = new ChildRegistry(join(this.home, "children.json"));
    this.approvals = new ApprovalManager(this.bus, this.audit, base.approvals);
    this.tools = new ToolRegistry(this.approvals, this.audit, this.hooks);
    this.tools.lang = () => this.assistant.language;
    // Langue des messages : celle de l'assistant pour ce qui est dit (voix), celle de l'interface pour ce qui est lu.
    this.approvals.lang = () => this.assistant.language;
    this.settings = new SettingsRegistry(join(this.home, "settings.json"), this.approvals, this.audit, (via) => (via === "voice" ? this.assistant.language : this.uiLang));
    // Outils internes des réglages : redéclarés quand la liste des réglages change (descriptions à jour).
    let offSettingsTools = () => {};
    const refreshSettingsTools = () => { offSettingsTools(); offSettingsTools = this.tools.register("core", settingsTools(this.settings)); };
    refreshSettingsTools();
    this.settings.onChange(refreshSettingsTools);
    this.secrets = opts.secrets ?? (opts.home ? defaultSecrets((msg) => this.logger({ level: "warn", source: "core", msg })) : new MemorySecrets());
    this.items = new CatalogRegistry(this.approvals, this.audit, (via) => (via === "voice" ? this.assistant.language : this.uiLang));
    // Outils internes du catalogue : redéclarés quand les rubriques changent (enum à jour).
    let offCatalogTools = () => {};
    let catalogSections = "";
    const refreshCatalogTools = () => {
      const key = this.items.sections().join("|");
      if (key === catalogSections) return;
      catalogSections = key;
      offCatalogTools(); offCatalogTools = this.tools.register("core", catalogTools(this.items));
    };
    refreshCatalogTools();
    this.items.onChange(refreshCatalogTools);
    this.downloads = new DownloadManager(opts.downloads);
    this.machineOpts = opts.machine ?? {};
    this.modelsDir = join(this.home, "models");
    this.uiLang = this.settings.savedValue<string>("langue_interface") ?? "fr";
    // Langue de l'interface, langue de l'assistant, dossiers : réglages du noyau (core-settings.ts).
    declareCoreSettings(this as unknown as KernelInternals);
    for (const p of opts.plugins ?? []) this.register(p);
    this.apps = new Apps({
      home: this.home, items: this.items, tools: this.tools,
      manifests: () => [...this.catalog.values()].map((d) => d.manifest),
      baseEntries: () => this.baseCfg?.plugins ?? [],
      entryState: (id) => { const e = this.entries.get(id); return e ? { state: e.state, ...(e.error ? { error: e.error } : {}) } : undefined; }, // erreur en { fr, en } : la fenêtre choisit
      entryNote: (id) => this.notes.get(id),
      entryLogo: (id) => this.logos.get(id),
      entryActions: (id) => this.appActions.get(id),
      entrySettings: (id) => this.settings.list().filter((x) => x.source === id).map((x) => x.key),
      setTransform: (fn) => {
        this.transform = fn;
        if (!this.baseCfg) return Promise.resolve();
        const base = this.baseCfg;
        return this.enqueue(() => this.applyNow(base));
      },
    });
    this.apps.refresh();
    this.tasks = new TaskRegistry(join(this.home, "tasks.json"), {
      declared: () => [...this.entries.values()]
        .filter((e) => e.def && e.state !== "disabled")
        .flatMap((e) => (e.def!.manifest.tasks ?? []).map((def) => ({ entry: e.cfg.id, plugin: e.cfg.plugin, def }))),
      acquire: (entry) => this.enqueue(async () => {
        this.hold(entry, 1);
        const x = await this.ensureActive(entry);
        const service = x?.provided.get("task") as TaskService | undefined;
        if (!service) { this.hold(entry, -1); await this.reconcile(); return undefined; }
        let done = false;
        return { service, release: () => { if (done) return; done = true; this.hold(entry, -1); void this.enqueue(() => this.reconcile()).catch(() => {}); } };
      }),
      announce: (info, result, raison) => {
        if (result.annonce !== "silence") {
          this.bus.emit("initiative", { source: info.key, text: result.resume, importance: result.annonce ?? "normal", key: `task:${info.key}:${Date.now()}` });
        }
        if (result.document) {
          const docs = this.service<DocumentsService>("documents");
          docs?.show(result.document.id).catch((e) => this.log("warn", info.key, `document non montré : ${e instanceof Error ? e.message : String(e)}`));
        }
        this.bus.emit("task.done", { key: info.key, label: info.label, raison, result });
      },
      audit: this.audit,
      log: (level, source, msg) => this.log(level, source, msg),
    });
    // Outils « taches » et « lancer_tache » : redéclarés quand la liste des tâches change (description à jour).
    let offTaskTools = () => {};
    let taskKeys = "";
    const refreshTaskTools = () => {
      const key = this.tasks.list().map((t) => t.key).join("|");
      if (key === taskKeys) return;
      taskKeys = key;
      offTaskTools(); offTaskTools = key ? this.tools.register("core", taskTools(this.tasks)) : () => {};
    };
    this.tasks.onChange(refreshTaskTools);
    this.bus.on("plugin.state", () => this.tasks.changed());
    this.bus.on("plugin.state", () => this.items.changed());
    // Un élément ajouté, masqué ou supprimé change ce que les slots peuvent donner : on recalcule (une fois, dans la file).
    let recheck = false;
    this.items.onChange(() => {
      if (recheck || !this.baseCfg) return;
      recheck = true;
      void this.enqueue(async () => { recheck = false; await this.reconcile(); })
        .catch((e) => this.log("error", "core", `recalcul après un changement d'élément : ${e instanceof Error ? e.message : String(e)}`));
    });
  }

  /** Vérifie le manifeste. Invalide : noté (l'entrée sera en erreur), jamais enregistré. */
  private checkManifest(def: PluginDef<any>): boolean {
    const bad = manifestError(def?.manifest);
    const id = String((def?.manifest as { id?: unknown } | undefined)?.id);
    if (!bad) { this.invalid.delete(id); return true; }
    this.invalid.set(id, bad);
    this.catalog.delete(id);
    this.log("error", id, `manifeste invalide : ${bad}`);
    return false;
  }

  register(def: PluginDef<any>): void {
    if (!this.checkManifest(def)) return;
    if (this.catalog.has(def.manifest.id)) throw new Error(`plugin déjà enregistré : ${def.manifest.id}`);
    this.catalog.set(def.manifest.id, def);
    this.declareSections(def);
    declareServiceSelection(this as unknown as KernelInternals, def);
    declareSlots(this as unknown as KernelInternals, def);
    this.apps?.refresh();
    this.tasks?.changed();
  }

  /** Rubriques déclarées par le manifeste (`manifest.sections`) : visibles dès que le plugin est installé. */
  private declareSections(def: PluginDef<any>): void {
    const id = def.manifest.id;
    this.sectionOffs.get(id)?.();
    this.sectionOffs.set(id, this.sections.declare(id, def.manifest.sections ?? []));
  }

  /**
   * Remplace la définition d'un plugin (ou l'enregistre s'il est nouveau).
   * Toutes les entrées qui l'utilisent s'arrêtent (avec leurs dépendants) puis redémarrent avec le nouveau code.
   */
  replacePlugin(def: PluginDef<any>): Promise<void> {
    return this.enqueue(async () => {
      if (this.checkManifest(def)) { this.catalog.set(def.manifest.id, def); this.declareSections(def); declareServiceSelection(this as unknown as KernelInternals, def); declareSlots(this as unknown as KernelInternals, def); }
      else this.sectionOffs.get(String((def?.manifest as { id?: unknown } | undefined)?.id))?.();
      const mine = [...this.entries.values()].filter((e) => e.cfg.plugin === def.manifest.id);
      for (const e of [...mine].reverse()) await this.stopEntry(e, "loaded");
      for (const e of mine) this.entries.set(e.cfg.id, this.makeEntry(e.cfg));
      await this.reconcile();
    });
  }

  /**
   * Entrées en plus de la config du fichier (plugins utilisateur). Gardées par chaque applyConfig.
   * Un id déjà pris par la config du fichier est ignoré (avertissement).
   */
  setExtraEntries(entries: EntryConfig[]): Promise<void> {
    this.extraEntries = entries.map((e) => ({ ...e }));
    if (!this.baseCfg) return this.idle();
    const base = this.baseCfg;
    return this.enqueue(() => this.applyNow(base));
  }

  /** Applique une nouvelle config : seules les entrées changées (et leurs dépendants) redémarrent. */
  applyConfig(input: KernelConfigInput | KernelConfig): Promise<void> {
    const cfg = KernelConfig.parse(input);
    this.stopped = false;
    return this.enqueue(() => this.applyNow(cfg));
  }

  private async applyNow(fileCfg: KernelConfig): Promise<void> {
    this.baseCfg = fileCfg;
    const base: KernelConfig = { ...fileCfg, plugins: this.transform(fileCfg.plugins) };
    const taken = new Set(base.plugins.map((p) => p.id));
    const extra = this.extraEntries.filter((e) => {
      if (!taken.has(e.id)) { taken.add(e.id); return true; }
      this.log("warn", e.id, "entrée en plus ignorée : id déjà pris");
      return false;
    });
    const cfg: KernelConfig = {
      ...base, plugins: [...base.plugins, ...extra],
      assistant: { ...base.assistant, ...(this.assistantLang ? { language: this.assistantLang } : {}) },
    };
    {
      if (stableStringify(cfg.assistant) !== stableStringify(this.assistant)) {
        // Nom, langue ou mots d'activation changés : tout le monde redémarre avec les nouveaux réglages.
        for (const e of [...this.entries.values()].reverse()) await this.stopEntry(e, "loaded");
        this.assistant = cfg.assistant;
      }
      this.approvals.setSettings(cfg.approvals);

      const next = new Map<string, Entry>();
      const wanted = new Map(cfg.plugins.map((p) => [p.id, p]));
      // 1. Arrêter les entrées retirées ou changées.
      for (const e of [...this.entries.values()].reverse()) {
        const w = wanted.get(e.cfg.id);
        if (!w || !sameEntry(w, e.cfg)) await this.stopEntry(e, "loaded");
      }
      // 2. Construire la nouvelle liste, dans l'ordre de la config.
      for (const w of cfg.plugins) {
        const old = this.entries.get(w.id);
        next.set(w.id, old && sameEntry(w, old.cfg) ? old : this.makeEntry(w));
      }
      for (const old of this.entries.values()) if (![...next.values()].includes(old)) { clearTimeout(old.retryTimer); delete old.retryTimer; }
      this.entries = next;
      this.selection = cfg.services;
      this.slotDefaults = cfg.slots;
      await this.reconcile();
      this.tasks.changed(); // une entrée endormie ajoutée ou retirée ne change pas d'état : on prévient ici
    }
  }

  /** Relance les forks d'une entrée (nouveau programme) : ceux en marche repartent, ceux en panne sont réessayés. */
  restartForks(parent: string, service?: string): Promise<void> {
    return this.enqueue(async () => {
      const list = [...this.forks.entries()].filter(([, f]) => f.fork!.parent === parent && (!service || f.fork!.service === service));
      for (const [key, f] of list) {
        // Un fork en panne n'a rien fourni : ceux qui le voulaient (slot) tournent sans lui ; ils repartent pour le redemander.
        if (f.state === "error") {
          for (const y of [...this.all()]) if (y.state === "active" && [...y.slotBound.values()].includes(key)) await this.stopEntry(y, "loaded");
        }
        if (f.state !== "loaded") await this.stopEntry(f, "loaded");
        this.forks.delete(key);
      }
      if (list.length) await this.reconcile();
    });
  }

  /** Relance une entrée en erreur (ou active). */
  restart(id: string): Promise<void> {
    return this.enqueue(async () => {
      const f = this.forks.get(id);
      if (f) { await this.stopEntry(f, "loaded"); this.forks.delete(id); await this.reconcile(); return; }
      const e = this.entries.get(id);
      if (!e) throw new TextError(T(`entrée inconnue : ${id}`, `unknown entry: ${id}`));
      clearTimeout(e.retryTimer);
      await this.stopEntry(e, "loaded");
      const fresh = this.makeEntry(e.cfg);
      this.entries.set(id, fresh);
      await this.reconcile();
    });
  }

  /** Arrête tout (ordre inverse de la config). */
  stopAll(): Promise<void> {
    this.stopped = true;
    for (const e of this.all()) { clearTimeout(e.retryTimer); delete e.retryTimer; }
    // Un démarrage en cours (modèle qui charge) ne doit pas retarder l'arrêt : il est annulé tout de suite.
    for (const e of this.all()) if (e.state === "starting") this.abortStart(e, T("arrêt de Floppy", "Floppy is stopping"), { cancelled: true });
    return this.enqueue(async () => {
      // Un démarrage commencé entre-temps (la file finissait un travail) est annulé aussi.
      for (const e of this.all()) if (e.state === "starting") this.abortStart(e, T("arrêt de Floppy", "Floppy is stopping"), { cancelled: true });
      this.approvals.cancelAll();
      for (const e of [...this.entries.values()].reverse()) await this.stopEntry(e, "loaded");
    });
  }

  /** Attend la fin des opérations en cours. */
  idle(): Promise<void> {
    return this.enqueue(async () => {});
  }

  /** Manifestes des plugins connus (catalogue). */
  manifests(): Manifest[] {
    return [...this.catalog.values()].map((d) => d.manifest);
  }

  /** Ce que Floppy lit de la machine (puce graphique, mémoire pour les modèles, RAM, disque). Relu au plus toutes les 60 s. */
  machine(fresh = false): Promise<MachineInfo> {
    const now = Date.now();
    if (!fresh && this.machineCache && now - this.machineCache.at < 60_000) return this.machineCache.info;
    const llamaExe = this.settings.savedValue<string>("llm_local_programme") || findExe("llama-server");
    const info = probeMachine({
      diskDir: existsSync(this.modelsDir) ? this.modelsDir : this.home,
      ...(llamaExe ? { llamaExe } : {}), ...(this.machineHint ? { hint: this.machineHint } : {}), ...this.machineOpts,
    });
    this.machineCache = { at: now, info };
    return info;
  }

  /**
   * Emprunte un élément offert (« <entrée>/<élément> ») pour l'hôte (ex. test de vitesse du premier lancement) :
   * le noyau le fait tourner jusqu'à release(). Undefined : élément absent ou en panne.
   */
  borrowItem<T = unknown>(service: string, value: string): Promise<{ service: T; release(): void } | undefined> {
    const cut = value.indexOf("/");
    if (cut < 1) return Promise.resolve(undefined);
    const entry = value.slice(0, cut);
    const item = value.slice(cut + 1);
    return this.enqueue(async () => {
      const p = this.entries.get(entry);
      const offer = p?.state === "active" ? p.offers.get(service) : undefined;
      if (!offer || !offerItems(offer).some((i) => i.id === item)) return undefined;
      const key = `${entry}/${service}/${item}`;
      this.hold(key, 1);
      const f = await this.ensureFork(key);
      const svc = f?.provided.get(service) as T | undefined;
      if (!svc) { this.hold(key, -1); await this.reconcile(); return undefined; }
      let done = false;
      return {
        service: svc,
        release: () => {
          if (done) return;
          done = true;
          this.hold(key, -1);
          void this.enqueue(() => this.reconcile()).catch(() => {});
        },
      };
    });
  }

  status(): EntryStatus[] {
    return this.all().map((e) => ({
      id: e.cfg.id,
      plugin: e.cfg.plugin,
      state: e.state,
      provides: e.state === "active" ? [...e.provided.keys()] : e.fork ? [e.fork.service] : (e.def?.manifest.provides ?? []),
      ...(e.error ? { error: tr(e.error, this.uiLang) } : {}),
      ...(e.missing?.length ? { missing: e.missing } : {}),
      ...(e.def?.manifest.lazy ? { lazy: true } : {}),
      ...(e.fork ? { fork: { ...e.fork } } : {}),
    }));
  }

  /** Les slots, leur choix et l'état de l'élément choisi. */
  slots(): SlotStatus[] {
    return [...this.slotDefs.values()].map(({ def, owner }) => {
      const key = this.slotKey(def.id);
      const f = key ? this.forks.get(key) : undefined;
      return {
        id: def.id, service: def.service, section: def.section, label: def.label, owner,
        ...(def.description ? { description: def.description } : {}), ...(def.none ? { none: def.none } : {}), ...(def.display ? { display: def.display } : {}),
        ...(def.step ? { step: def.step } : {}),
        value: this.slotValue(def.id),
        state: f ? f.state : key ? "idle" : "none",
        ...(f?.error ? { error: tr(f.error, this.uiLang) } : {}),
      };
    });
  }

  /** Fournisseur actif d'un service (pour l'app hôte et les tests). */
  service<T = unknown>(name: string): T | undefined {
    const id = this.providerOf(name);
    return id ? (this.entries.get(id)!.provided.get(name) as T) : undefined;
  }

  /**
   * Erreur rattrapée par le filet global : rend l'id de l'entrée dont le code tournait (ou undefined).
   * Une exception non rattrapée met ce plugin en panne (son état n'est plus sûr) ; une promesse rejetée est seulement notée.
   */
  blame(kind: "unhandledRejection" | "uncaughtException", err: unknown): string | undefined {
    const id = this.als.getStore();
    if (!id) return undefined;
    const e = this.entries.get(id) ?? this.forks.get(id);
    const msg = err instanceof Error ? err.message : String(err);
    this.log("error", id, `${kind === "uncaughtException" ? "exception non rattrapée" : "promesse rejetée non suivie"} : ${err instanceof Error ? err.stack ?? msg : msg}`);
    if (kind === "uncaughtException" && e && (e.state === "active" || e.state === "starting")) {
      e.fail?.(T(`erreur non rattrapée : ${msg}`, `uncaught error: ${msg}`));
    }
    return id;
  }

  get assistantSettings(): AssistantSettings {
    return this.assistant;
  }

  // ------------------------------------------------------------------ interne

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Le travail du noyau ne tourne au nom d'aucun plugin, même demandé par le code d'un plugin (ctx.fail, emprunt…) :
    // une panne pendant l'arrêt d'un autre plugin ne doit pas être rendue à celui qui a demandé.
    const job = () => this.als.exit(fn);
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  private makeEntry(cfg: EntryConfig): Entry {
    const e: Entry = { cfg, state: "loaded", provided: new Map(), bound: new Map(), used: new Set(), slotBound: new Map(), offers: new Map(), retries: 0 };
    if (cfg.disabled) { e.state = "disabled"; return e; }
    const bad = this.invalid.get(cfg.plugin);
    if (bad) return this.setError(e, T(`manifeste invalide : ${bad}`, `invalid manifest: ${bad}`));
    const def = this.catalog.get(cfg.plugin);
    if (!def) {
      // Un paquet de plugin qui ne se charge pas est peut-être celui-ci : on le dit (on ne connaît pas son id).
      const why = this.unloaded.map((u) => `${u.pkg} (${u.error.slice(0, 160)})`).join(" ; ");
      return this.setError(e, why
        ? T(`plugin inconnu : ${cfg.plugin}. Ces plugins ne se chargent pas : ${why}`, `unknown plugin: ${cfg.plugin}. These plugins don't load: ${why}`)
        : T(`plugin inconnu : ${cfg.plugin}`, `unknown plugin: ${cfg.plugin}`));
    }
    e.def = def;
    if (def.config) {
      const r = def.config.safeParse(cfg.config ?? {});
      if (!r.success) {
        const issues = (root: string) => r.error.issues.map((i) => `${i.path.join(".") || root} ${i.message}`).join(" ; ");
        return this.setError(e, T(`config invalide : ${issues("(racine)")}`, `invalid config: ${issues("(root)")}`));
      }
      e.parsed = r.data;
    } else {
      e.parsed = cfg.config ?? {};
    }
    return e;
  }

  private setError(e: Entry, msg: Text): Entry {
    e.state = "error";
    e.error = msg;
    this.emitState(e);
    this.log("error", e.cfg.id, tr(msg, "fr"));
    return e;
  }

  /** Fournisseur choisi pour un service : la sélection de la config, sinon le premier actif dans l'ordre. */
  private providerOf(name: string): string | undefined {
    const chosen = this.selectedProvider(name);
    if (chosen === "@none") return undefined;
    if (chosen) {
      const e = this.entries.get(chosen);
      return e?.state === "active" && e.provided.has(name) ? chosen : undefined;
    }
    for (const e of this.entries.values()) if (e.state === "active" && e.provided.has(name)) return e.cfg.id;
    return undefined;
  }

  /**
   * Fournisseur d'un lien faible (optional lu sans ctx.use) : jamais un plugin lazy. Il tourne seulement pour ceux qui
   * le demandent ; le voir ou le perdre ne doit pas redémarrer les autres.
   */
  private weakProviderOf(name: string): string | undefined {
    const id = this.providerOf(name);
    return id && this.entries.get(id)?.def?.manifest.lazy ? undefined : id;
  }

  private selectedProvider(name: string): string | undefined {
    return this.selectionEdits.get(name) ?? (this.selectable.has(name) ? this.settings.savedValue<string>(`service.${name}`) : undefined)
      ?? this.selection[name] ?? (this.selectable.has(name) ? "@none" : undefined);
  }

  private needs(e: Entry): { required: string[]; optional: string[] } {
    if (e.fork) return { required: [], optional: [] }; // un fork vit dans son parent : il demande ce qu'il lui faut avec ctx.use
    return { required: e.def?.manifest.inject ?? [], optional: e.def?.manifest.optional ?? [] };
  }

  private all(): Entry[] {
    return [...this.entries.values(), ...this.forks.values()];
  }

  private lazy(e: Entry): boolean {
    return !!e.fork || !!e.def?.manifest.lazy;
  }

  /**
   * Fournisseur pour un besoin fort (inject, ctx.use) : le choisi, sinon le premier actif, sinon le premier en veille (lazy).
   * Un fournisseur en veille compte : il sera démarré pour ce besoin.
   */
  private candidateOf(name: string): string | undefined {
    const ok = (e?: Entry): boolean => {
      if (!e?.def || !(e.def.manifest.provides ?? []).includes(name)) return false;
      if (e.state === "active") return e.provided.has(name);
      return !!e.def.manifest.lazy && (e.state === "loaded" || e.state === "waiting");
    };
    const chosen = this.selectedProvider(name);
    if (chosen === "@none") return undefined;
    if (chosen) return ok(this.entries.get(chosen)) ? chosen : undefined;
    for (const e of this.entries.values()) if (e.state === "active" && ok(e)) return e.cfg.id;
    for (const e of this.entries.values()) if (ok(e)) return e.cfg.id;
    return undefined;
  }

  /** Démarre une entrée en veille (et, d'abord, ce dont elle a besoin). Rend l'entrée si elle est active. */
  private async ensureActive(id: string | undefined): Promise<Entry | undefined> {
    const x = id ? this.entries.get(id) : undefined;
    if (!x) return undefined;
    if (x.state === "active") return x;
    if ((x.state !== "loaded" && x.state !== "waiting") || this.ensuring.has(x.cfg.id)) return undefined;
    this.ensuring.add(x.cfg.id);
    try {
      if (!(await this.startDeps(x))) return undefined;
      await this.startEntry(x);
      return (x.state as string) === "active" ? x : undefined;
    } finally {
      this.ensuring.delete(x.cfg.id);
    }
  }

  /** Démarre les fournisseurs en veille des services `inject`. Faux : il en manque (l'entrée passe en attente). */
  private async startDeps(e: Entry): Promise<boolean> {
    const missing: string[] = [];
    for (const s of this.needs(e).required) if (!(await this.ensureActive(this.candidateOf(s)))) missing.push(s);
    if (!missing.length) return true;
    if (e.state !== "waiting" || stableStringify(e.missing) !== stableStringify(missing)) {
      e.state = "waiting";
      e.missing = missing;
      this.emitState(e);
      this.log("warn", e.cfg.id, `en attente des services : ${missing.join(", ")}`);
    }
    return false;
  }

  /** Lien faible : service facultatif lu sans ctx.use (il ne garde pas son fournisseur en marche). */
  private weak(y: Entry, s: string): boolean {
    const { required, optional } = this.needs(y);
    return optional.includes(s) && !required.includes(s) && !y.used.has(s);
  }

  /** Quelqu'un (actif ou en démarrage) se sert-il de cette entrée ou de ce fork ? */
  private demanded(x: Entry): boolean {
    if (this.holds.get(x.cfg.id)) return true;
    for (const y of this.all()) {
      if (y === x || (y.state !== "active" && y.state !== "starting")) continue;
      for (const [s, p] of y.bound) if (p === x.cfg.id && !this.weak(y, s)) return true;
      for (const k of y.slotBound.values()) if (k === x.cfg.id) return true;
    }
    return false;
  }

  /** Un fournisseur ou un choix a-t-il changé depuis le démarrage de l'entrée ? */
  private drifted(e: Entry): boolean {
    const { required, optional } = this.needs(e);
    for (const s of required) if (this.candidateOf(s) !== e.bound.get(s)) return true;
    for (const s of optional) if (!e.used.has(s) && this.weakProviderOf(s) !== e.bound.get(s)) return true;
    for (const s of e.used) if (!required.includes(s) && this.candidateOf(s) !== e.bound.get(s)) return true;
    for (const [id, key] of e.slotBound) if (this.slotKey(id) !== key) return true;
    return false;
  }

  /** Garde (+1) ou relâche (-1) une entrée ou un fork en marche, le temps d'un travail. */
  private hold(id: string, d: 1 | -1): void {
    const n = (this.holds.get(id) ?? 0) + d;
    if (n > 0) this.holds.set(id, n); else this.holds.delete(id);
  }

  // ------------------------------------------------------------------ slots et forks

  private slotOptions(slot: SlotDef): (SettingOption & { cloud?: boolean })[] {
    const out: (SettingOption & { cloud?: boolean })[] = slot.none ? [{ value: "@none", label: slot.none }] : [];
    for (const e of this.entries.values()) {
      const offer = e.state === "active" ? e.offers.get(slot.service) : undefined;
      if (!offer) continue;
      for (const i of offerItems(offer)) {
        out.push({
          value: `${e.cfg.id}/${i.id}`, label: i.label,
          ...(i.aliases?.length ? { aliases: i.aliases } : {}), ...(i.slow ? { slow: true } : {}), ...(i.cloud ? { cloud: true } : {}),
        });
      }
    }
    return out;
  }

  /** Valeur d'un slot : le choix de l'utilisateur, sinon floppy.yml, sinon le premier élément (slot obligatoire) ou « aucun ». */
  private slotValue(id: string): string {
    const key = `slot.${id}`;
    const v = this.selectionEdits.get(key) ?? this.settings.savedValue<string>(key) ?? this.slotDefaults[id];
    const slot = this.slotDefs.get(id)?.def;
    if (v) return slot ? this.followRename(slot, v) : v;
    if (!slot || (slot.none && !slot.defaultFirst)) return "@none";
    return this.slotOptions(slot).find((o) => o.value !== "@none")?.value ?? "@none";
  }

  /** Choix « <entrée>/<ancien id> » d'un élément renommé par son plugin (OfferDef.renamed) : rend le nouvel id. */
  private followRename(slot: SlotDef, v: string): string {
    const cut = v.indexOf("/");
    if (cut < 1) return v;
    const p = this.entries.get(v.slice(0, cut));
    const to = (p?.state === "active" ? p.offers.get(slot.service) : undefined)?.renamed?.[v.slice(cut + 1)];
    return to ? `${v.slice(0, cut)}/${to}` : v;
  }

  /** Clé du fork choisi pour un slot ("<entrée>/<service>/<élément>"), si l'élément est offert en ce moment. */
  private slotKey(id: string): string | undefined {
    const slot = this.slotDefs.get(id)?.def;
    if (!slot) return undefined;
    const v = this.slotValue(id);
    const cut = v.indexOf("/");
    if (v === "@none" || cut < 1) return undefined;
    const entry = v.slice(0, cut);
    const item = v.slice(cut + 1);
    const p = this.entries.get(entry);
    const offer = p?.state === "active" ? p.offers.get(slot.service) : undefined;
    if (!offer || !offerItems(offer).some((i) => i.id === item)) return undefined;
    return `${entry}/${slot.service}/${item}`;
  }

  /** Démarre (si besoin) le fork d'un élément. Rend le fork s'il est actif. */
  private async ensureFork(key: string): Promise<Entry | undefined> {
    const [parent = "", service = ""] = key.split("/", 2);
    const item = key.slice(parent.length + service.length + 2);
    const p = this.entries.get(parent);
    const offer = p?.state === "active" ? p.offers.get(service) : undefined;
    if (!p || !offer) return undefined;
    let f = this.forks.get(key);
    if (f?.state === "active") return f;
    if (f && f.state !== "loaded") return undefined; // en panne (choisir de nouveau pour réessayer), ou déjà en démarrage
    if (!f) {
      f = {
        cfg: { id: key, plugin: p.cfg.plugin, disabled: false }, def: p.def!, parsed: p.parsed, state: "loaded",
        provided: new Map(), bound: new Map(), used: new Set(), slotBound: new Map(), offers: new Map(), retries: 0,
        fork: { parent, service, item },
      };
      this.forks.set(key, f);
    }
    if (offer.max) {
      const others = [...this.forks.values()]
        .filter((x) => x !== f && x.fork!.parent === parent && x.fork!.service === service && x.state === "active")
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      while (others.length >= offer.max) {
        const old = others.shift()!;
        this.log("info", old.cfg.id, `place libérée pour ${item}`);
        await this.stopEntry(old, "loaded");
        this.forks.delete(old.cfg.id);
      }
    }
    await this.startEntry(f);
    return f.state === "active" ? f : undefined;
  }

  /**
   * Un pas vers l'état voulu : redémarre une entrée dont un fournisseur ou un choix a changé, démarre une entrée prête,
   * sinon arrête ce qui ne sert plus (plugins lazy, forks). Rend vrai si quelque chose a changé.
   */
  private async step(): Promise<boolean> {
    // Floppy s'arrête : plus rien ne démarre ni ne redémarre (un emprunt rendu ne relance pas tout).
    if (this.stopped) return false;
    for (const e of this.all()) {
      if (e.state !== "active" || !this.drifted(e)) continue;
      this.log("info", e.cfg.id, "un fournisseur ou un choix a changé : redémarrage");
      await this.stopEntry(e, "loaded");
      if (e.fork) this.forks.delete(e.cfg.id);
      return true;
    }
    for (const e of this.entries.values()) {
      if ((e.state !== "loaded" && e.state !== "waiting") || this.lazy(e)) continue;
      const missing = this.needs(e).required.filter((s) => !this.candidateOf(s));
      if (missing.length) {
        if (e.state !== "waiting" || stableStringify(e.missing) !== stableStringify(missing)) {
          e.state = "waiting";
          e.missing = missing;
          this.emitState(e);
          this.log("warn", e.cfg.id, `en attente des services : ${missing.join(", ")}`);
        }
        continue;
      }
      if (!(await this.startDeps(e))) continue;
      await this.startEntry(e);
      return true; // un nouveau service peut débloquer une entrée plus haut dans la liste
    }
    // Plus personne ne s'en sert : on arrête (les plus récents d'abord).
    for (const e of this.all().reverse()) {
      if (!this.lazy(e) || this.demanded(e)) continue;
      if (e.fork) {
        if (e.state === "starting" || e.state === "stopping") continue;
        if (e.state === "active") { this.log("info", e.cfg.id, "plus utilisé : arrêt"); await this.stopEntry(e, "loaded"); }
        this.forks.delete(e.cfg.id);
        this.emitState(e);
        return true;
      }
      if (e.state === "active") { this.log("info", e.cfg.id, "plus utilisé : arrêt"); await this.stopEntry(e, "loaded"); return true; }
      if (e.state === "waiting") { e.state = "loaded"; delete e.missing; this.emitState(e); }
    }
    return false;
  }

  /** Démarre ce qui peut démarrer, redémarre ce dont un fournisseur a changé, arrête ce qui ne sert plus. Répète jusqu'à stabilité. */
  private async reconcile(): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) if (!(await this.step())) return;
    throw new Error("reconcile : pas de stabilité après 1000 tours (boucle de dépendances, ou deux slots qui se disputent un même fournisseur ?)");
  }

  private async startEntry(e: Entry): Promise<void> {
    const def = e.def!;
    e.state = "starting";
    delete e.missing;
    delete e.error;
    delete e.failReason;
    delete e.cancelled;
    e.bound = new Map();
    e.used = new Set();
    e.slotBound = new Map();
    e.offers = new Map();
    e.startedAt = ++this.seq;
    const { required, optional } = this.needs(e);
    for (const s of required) e.bound.set(s, this.candidateOf(s));
    for (const s of optional) if (!required.includes(s)) e.bound.set(s, this.weakProviderOf(s));
    this.emitState(e);
    const scope = new EffectScope();
    e.scope = scope;
    delete e.disposing;
    const pending = new Map<string, unknown>();
    const ctx = makeContext(this as unknown as KernelInternals, e, scope, pending);
    const offer = e.fork ? this.entries.get(e.fork.parent)?.offers.get(e.fork.service) : undefined;
    const limitS = e.fork ? (offer?.startTimeout_s ?? 600) : (def.manifest.startTimeout_s ?? this.startTimeoutMs / 1000);
    e.deadline = new Deadline(limitS * 1000, () => {
      this.log("error", e.cfg.id, `démarrage trop long (${limitS} s) : arrêté`);
      this.abortStart(e, T(`démarrage trop long (${limitS} s)`, `start took too long (${limitS} s)`));
    });
    try {
      // Le code du plugin tourne « au nom » de l'entrée (filet global). On cesse de l'attendre si le démarrage est
      // annulé (ctx.fail, délai, arrêt de Floppy) : il continue peut-être, mais son contexte est fermé.
      const run = this.als.run(e.cfg.id, () => Promise.resolve().then(() => {
        if (e.fork) {
          if (!offer) throw new Error("l'offre a disparu");
          return offer.start(ctx, e.fork.item);
        }
        return def.apply(ctx, e.parsed);
      }));
      run.catch(() => {});
      await Promise.race([run, scope.closing]);
      if (!scope.isClosed && e.fork && !pending.has(e.fork.service)) throw new Error(`l'élément ${e.fork.item} n'a pas fourni ${e.fork.service}`);
      if (scope.isClosed) { // ctx.fail(), délai ou arrêt pendant apply : les effets sont fermés, l'erreur est posée ici, une seule fois
        for (const err of (await (e.disposing as Promise<Error[]> | undefined)) ?? []) this.log("warn", e.cfg.id, `fermeture : ${err.message}`);
        delete e.disposing;
        e.scope = undefined;
        if (this.stopped && e.cancelled) {
          // Annulé par l'arrêt de Floppy : pas une panne. L'entrée repart normalement au prochain applyConfig.
          e.state = "loaded";
          this.emitState(e);
          return;
        }
        this.setError(e, e.failReason ?? T("arrêté pendant apply", "stopped during apply"));
        this.scheduleRetry(e);
        return;
      }
      if (!e.fork) for (const s of def.manifest.provides ?? []) {
        if (!pending.has(s) && !e.offers.has(s)) this.log("debug", e.cfg.id, `service déclaré mais pas fourni (réglage) : ${s}`);
      }
      e.provided = new Map(pending); // copie : un ctx.provide tardif ne doit pas devenir visible en silence
      e.state = "active";
      e.activeAt = Date.now();
      this.emitState(e);
      for (const name of pending.keys()) this.bus.emit("service.changed", { name, provider: this.providerOf(name) });
      this.log("info", e.cfg.id, "actif");
    } catch (err) {
      for (const x of (await (e.disposing ?? scope.dispose({ timeoutMs: this.disposeTimeoutMs })))) this.log("warn", e.cfg.id, `fermeture : ${x.message}`);
      e.scope = undefined;
      const why = errorText(err);
      this.setError(e, e.failReason ?? T(`${e.fork ? "démarrage" : "apply"} a échoué : ${tr(why, "fr")}`, `${e.fork ? "start" : "apply"} failed: ${tr(why, "en")}`));
      this.scheduleRetry(e);
    } finally {
      e.deadline?.stop();
      delete e.deadline;
    }
  }

  /** Annule un démarrage en cours : ferme ses effets ; startEntry cesse de l'attendre et pose l'erreur. */
  private abortStart(e: Entry, reason: Text, opts: { cancelled?: boolean } = {}): void {
    const scope = e.scope;
    if (e.state !== "starting" || !scope || scope.isClosed) return;
    if (opts.cancelled) e.cancelled = true;
    e.failReason ??= reason;
    e.disposing = scope.dispose({ timeoutMs: this.disposeTimeoutMs });
  }

  /**
   * Reprise automatique d'une entrée tombée en panne (pas d'une config invalide) : après 5 s, 30 s, puis 2 min.
   * Ensuite l'erreur reste visible jusqu'à une relance à la main ou un nouveau choix. Une entrée restée active plus
   * d'une minute avant sa panne repart avec tous ses essais.
   */
  private scheduleRetry(e: Entry): void {
    if (this.stopped || e.state !== "error" || !e.def || e.cfg.disabled || e.cancelled) return;
    if (e.activeAt && Date.now() - e.activeAt > 60_000) e.retries = 0;
    delete e.activeAt;
    const delay = this.retryDelays[e.retries];
    if (delay === undefined) { this.log("warn", e.cfg.id, "reprise abandonnée après plusieurs essais"); return; }
    e.retries++;
    clearTimeout(e.retryTimer);
    this.log("info", e.cfg.id, `nouvel essai dans ${Math.round(delay / 1000)} s (${e.retries}/${this.retryDelays.length})`);
    e.retryTimer = setTimeout(() => {
      delete e.retryTimer;
      void this.enqueue(() => this.retryNow(e)).catch((err) => this.log("warn", e.cfg.id, `nouvel essai : ${String(err)}`));
    }, delay);
    e.retryTimer.unref?.();
  }

  private async retryNow(e: Entry): Promise<void> {
    if (this.stopped || e.state !== "error") return;
    if (e.fork) {
      if (this.forks.get(e.cfg.id) !== e) return;
      // Ceux qui voulaient ce fork tournent sans lui : ils repartent pour le redemander (comme restartForks).
      for (const y of [...this.all()]) if (y.state === "active" && [...y.slotBound.values()].includes(e.cfg.id)) await this.stopEntry(y, "loaded");
      e.state = "loaded";
      delete e.error;
      this.emitState(e);
      await this.reconcile();
      return;
    }
    if (this.entries.get(e.cfg.id) !== e) return;
    e.state = "loaded";
    delete e.error;
    this.emitState(e);
    await this.reconcile();
  }

  /** Arrête une entrée : d'abord celles qui utilisent ses services, puis ses forks, puis elle-même. */
  private async stopEntry(e: Entry, after: "loaded" | "error"): Promise<void> {
    if (e.state === "active") {
      const mine = [...e.provided.keys()];
      for (const other of this.all().reverse()) {
        if (other === e || other.state !== "active") continue;
        const uses = [...other.bound.entries()].some(([s, p]) => p === e.cfg.id && mine.includes(s))
          || [...other.slotBound.values()].includes(e.cfg.id);
        if (uses) await this.stopEntry(other, "loaded");
      }
    }
    for (const f of [...this.forks.values()]) {
      if (f.fork!.parent !== e.cfg.id) continue;
      await this.stopEntry(f, "loaded");
      this.forks.delete(f.cfg.id);
    }
    if (!e.scope) {
      if (e.state === "waiting") { e.state = "loaded"; delete e.missing; }
      return;
    }
    const wasActive = e.state === "active";
    e.state = "stopping";
    this.emitState(e);
    const provided = [...e.provided.keys()];
    e.provided = new Map();
    e.offers = new Map();
    const scope = e.scope;
    const errors = await (e.disposing ?? this.als.run(e.cfg.id, () => scope.dispose({ timeoutMs: this.disposeTimeoutMs })));
    delete e.disposing;
    e.scope = undefined;
    if (e.fork) this.loseBorrowers(e.cfg.id);
    for (const err of errors) this.log("warn", e.cfg.id, `fermeture : ${err.message}`);
    if (after === "loaded" && e.cfg.disabled) e.state = "disabled";
    else e.state = after === "error" ? "error" : (e.def ? "loaded" : "error");
    this.emitState(e);
    if (wasActive) for (const name of provided) this.bus.emit("service.changed", { name, provider: this.providerOf(name) });
  }

  /** Prévient ceux qui ont emprunté ce fork : il s'est arrêté (panne, arrêt, nouveau choix). */
  private loseBorrowers(key: string): void {
    const set = this.borrowers.get(key);
    if (!set) return;
    this.borrowers.delete(key);
    for (const fn of set) { try { fn(); } catch { /* rien */ } }
  }

  private emitState(e: Entry): void {
    this.bus.emit("plugin.state", {
      id: e.cfg.id, plugin: e.cfg.plugin, state: e.state,
      ...(e.error ? { error: tr(e.error, this.uiLang) } : {}),
      ...(e.missing?.length ? { missing: e.missing } : {}),
    });
  }

  private log(level: LogLevel, source: string, msg: string, data?: Record<string, unknown>): void {
    this.logger({ level, source, msg, ...(data ? { data } : {}) });
  }
}
