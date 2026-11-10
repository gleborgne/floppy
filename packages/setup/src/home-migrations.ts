// Les étapes de migration du répertoire de travail (le moteur est dans @floppy/core : `runHomeMigrations`).
// Une étape par changement de nom d'un identifiant que Floppy a déjà écrit chez l'utilisateur : elle convertit le
// fichier une fois, le code ne lit ensuite que les nouveaux noms (pas de « les deux noms pour toujours »).
// Ajouter une étape : une entrée de plus (version suivante), idempotente, qui rapporte des noms de clés (jamais des valeurs).
// Non migrés, par choix : l'audit (`audit.jsonl`) est un journal, les nouveaux enregistrements portent les nouveaux noms.
import { TOOL_RENAMES, FIXED_SOURCES } from "./tool-names.ts";
import { patchYaml, runHomeMigrations, yamlPluginEntries, YamlUnreadable, type MigrationEnv, type MigrationOptions, type MigrationReport, type MigrationStep, type YamlOp, type YamlStep } from "@floppy/core";

/** Étape 1. Documents (`<home>/documents/*.md`) : la clé `titre:` de l'en-tête devient `title:`. */
const documentTitle: MigrationStep = {
  id: "documents-title",
  version: 1,
  label: "documents : la clé d'en-tête « titre » devient « title »",
  run(env) {
    for (const file of env.list("documents", ".md")) {
      env.editText(file, (text) => {
        const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
        if (!m) return undefined;
        const head = m[2]!;
        if (!/^titre[ \t]*:/m.test(head)) return undefined;
        if (/^title[ \t]*:/m.test(head)) { env.skip(file, "conflict"); return undefined; }
        const next = head.replace(/^titre([ \t]*:)/m, "title$1");
        return { text: m[1] + next + text.slice(m[1]!.length + head.length), keys: ["titre"] };
      });
    }
  },
};

/** Valeurs de niveau du premier lancement : français → anglais. */
const LEVELS: Record<string, string> = { texte: "text", voix: "voice", hybride: "hybrid" };

/** Étape 2. Premier lancement (`<home>/onboarding.json`) : les valeurs de `level` passent en anglais. */
const onboardingLevel: MigrationStep = {
  id: "onboarding-level",
  version: 2,
  label: "premier lancement : les niveaux « texte / voix / hybride » deviennent « text / voice / hybrid »",
  run(env) {
    env.editJson("onboarding.json", (data) => {
      const level = data.level;
      if (typeof level !== "string" || !Object.hasOwn(LEVELS, level)) return [];
      data.level = LEVELS[level];
      return ["level"];
    });
  },
};

/**
 * Étape 3. Premier lancement (`<home>/onboarding.json`) : les niveaux disparaissent au profit d'un choix de modèle par rôle
 * (`selection`). `level` (et `brain`, qui vivait à côté) n'ont pas de valeur équivalente sans lire la machine : ils sont retirés.
 * Une installation coupée (`done: false`) n'est donc pas reprise toute seule : la fenêtre « Bienvenue » revient, et l'utilisateur choisit.
 */
const onboardingSelection: MigrationStep = {
  id: "onboarding-selection",
  version: 3,
  label: "premier lancement : les niveaux (`level`, `brain`) laissent place au choix par rôle (`selection`)",
  run(env) {
    env.editJson("onboarding.json", (data) => {
      const keys = ["level", "brain"].filter((k) => Object.hasOwn(data, k));
      for (const k of keys) delete data[k];
      return keys;
    });
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Étapes 10 à 15 : tout ce qui est gardé ou configuré passe en anglais (réglages, configuration, éléments, préférences).
// Chacune est complète : elle couvre un fichier ou une famille de fichiers de bout en bout.
// ---------------------------------------------------------------------------------------------------------------

/** Clés de `settings.json` : ancien nom → nouveau nom. */
const SETTING_KEYS: Readonly<Record<string, string>> = {
  expressivite: "expressiveness", ton: "tone", ecoute_libre: "free_listen_s",
  langue_interface: "ui_language", langue_assistant: "assistant_language", dossier_floppy: "home_folder",
  masquer_apres: "hide_after", bulle: "bubble", toujours_devant: "always_on_top", demarrage_windows: "autostart",
  raccourci_parler: "shortcut_talk", raccourci_ecrire: "shortcut_write", raccourci_dicter: "shortcut_dictate",
  raccourci_dormir: "shortcut_sleep", raccourci_avatar: "shortcut_avatar",
  llm_local_programme: "llm_local_program", llm_local_dossiers: "llm_local_folders",
  tts_local_programme: "tts_local_program", tts_local_dossiers: "tts_local_folders",
  assistant_modele_claude: "assistant_claude_model", plugins_tiers_relecteur: "third_party_plugins_reviewer",
  "slot.veille.tri": "slot.watch.triage", "slot.veille.recherche": "slot.watch.search",
};

/** Clés que plus rien ne lit (anciens rôles `slot.brain.main` / `slot.voice.tts`, ancien `service.<nom>`) : supprimées. */
const ORPHAN_SETTINGS = ["cerveau", "voix", "service.live"] as const;

/** Nouveau nom d'une clé de réglage, ou undefined : les réglages des tâches sont `taches.<entrée>.<tâche>[.envoi]`. */
function newSettingKey(key: string): string | undefined {
  if (Object.hasOwn(SETTING_KEYS, key)) return SETTING_KEYS[key];
  if (key.startsWith("taches.")) return `tasks.${key.slice("taches.".length)}`.replace(/\.envoi$/, ".send");
  return undefined;
}

/** Étape 10. Réglages (`<home>/settings.json`) : les clés passent en anglais ; trois clés orphelines sont supprimées. */
const settingsKeys: MigrationStep = {
  id: "settings-keys",
  version: 10,
  label: "réglages : les clés françaises passent en anglais (ton → tone, masquer_apres → hide_after, taches.* → tasks.*…)",
  run(env) {
    env.editJson("settings.json", (data) => {
      const changed: string[] = [];
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if ((ORPHAN_SETTINGS as readonly string[]).includes(key)) { changed.push(key); continue; }
        const to = newSettingKey(key);
        if (to === undefined) { next[key] = value; continue; }
        changed.push(key);
        // Les deux noms présents : le nouveau gagne, l'ancien est retiré (la copie `.bak-settings-keys` garde l'original).
        if (Object.hasOwn(data, to)) { env.conflict("settings.json", key); continue; }
        next[to] = value;
      }
      if (!changed.length) return [];
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, next);
      return changed;
    });
  },
};

const DAYS_EN: Readonly<Record<string, string>> = { lun: "mon", mar: "tue", mer: "wed", jeu: "thu", ven: "fri", sam: "sat", dim: "sun" };

/** Une planification écrite comme l'ancien code la gardait (« 07:30 lun-ven », « toutes les 3h », « jamais ») : sa forme anglaise. Autre texte : undefined. */
export function scheduleToEnglish(value: string): string | undefined {
  const v = value.trim();
  if (v === "jamais") return "never";
  const every = /^toutes les (\d+)(h| min)$/.exec(v);
  if (every) return `every ${every[1]}${every[2]}`;
  const at = /^(\d{2}:\d{2}) (.+)$/.exec(v);
  if (!at) return undefined;
  const parts: string[] = [];
  for (const part of at[2]!.split(",")) {
    const days = part.split("-");
    if (days.length > 2 || days.some((d) => !Object.hasOwn(DAYS_EN, d))) return undefined;
    parts.push(days.map((d) => DAYS_EN[d]).join("-"));
  }
  return `${at[1]} ${parts.join(",")}`;
}

const ORCA_NOTIFICATIONS: Readonly<Record<string, string>> = { toutes: "all", importantes: "important", aucune: "none" };

/** Nouvelle valeur d'un réglage dont la valeur change, ou undefined (rien à changer). */
function newSettingValue(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Les réglages d'une application de la boîte aux lettres : « non » devient `denied`.
  if (key.startsWith("inbox_app_")) return value === "non" ? "denied" : undefined;
  if (key === "orca_notifications") return Object.hasOwn(ORCA_NOTIFICATIONS, value) ? ORCA_NOTIFICATIONS[value] : undefined;
  // Les réglages des tâches : planification, ou canaux d'envoi (« nulle part » devient `nowhere`).
  if (key.startsWith("tasks.")) return key.endsWith(".send") ? (value.trim() === "nulle part" ? "nowhere" : undefined) : scheduleToEnglish(value);
  return undefined;
}

/** Étape 11. Réglages (`<home>/settings.json`) : les valeurs françaises des réglages à choix et des tâches passent en anglais. */
const settingsValues: MigrationStep = {
  id: "settings-values",
  version: 11,
  label: "réglages : valeurs « toutes / importantes / aucune », « non » (applications), « jamais », « nulle part » → all / important / none, denied, never, nowhere",
  run(env) {
    env.editJson("settings.json", (data) => {
      const changed: string[] = [];
      for (const [key, value] of Object.entries(data)) {
        const to = newSettingValue(key, value);
        if (to === undefined) continue;
        data[key] = to;
        changed.push(key);
      }
      return changed;
    });
  },
};

/**
 * Ce qui change dans une table de configuration d'un plugin. Les noms sont les ANCIENS ; `each` descend dans chaque
 * valeur d'une clé (une table d'éléments choisis par l'utilisateur : `models.<id>`, `interets.<id>`).
 */
interface Rule {
  rename?: Readonly<Record<string, string>>;
  /** Clé (ancien nom) → valeurs texte à remplacer. */
  values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  each?: Readonly<Record<string, Rule>>;
}

/** Configuration des plugins (`plugins[].config` de floppy.yml, et les copies de `items/apps.json`), par identifiant de plugin. */
const CONFIG_RULES: Readonly<Record<string, Rule>> = {
  "tts-audiocpp": { each: { models: { rename: { famille: "family", voix: "voice", langue: "language" }, values: { voix: { integree: "builtin" } } } } },
  veille: {
    rename: { interets: "interests", seuil: "threshold", lot: "batch", maxVersModele: "maxToModel", fenetreJours: "windowDays" },
    each: { interets: { rename: { nom: "name", flux: "feeds", requetes: "queries" } } },
  },
  scheduler: { rename: { delaiDemarrageS: "startupDelay_s" } },
  searxng: { rename: { langue: "language" } },
  "agent-sessions": { rename: { dossier: "folder" } },
  orca: { values: { notifications: ORCA_NOTIFICATIONS } },
};

/** Valeurs d'un élément d'un fournisseur (`items/<entrée>.json` : `added.<id>.values` et `edits.<id>`), par identifiant de plugin. */
const ITEM_RULES: Readonly<Record<string, { kinds?: Readonly<Record<string, string>>; fields: Rule }>> = {
  "tts-audiocpp": { fields: { rename: { famille: "family", familleAutre: "familyOther", voix: "voice", langue: "language" }, values: { voix: { integree: "builtin" }, famille: { autre: "other" } } } },
  veille: { kinds: { interet: "interest" }, fields: { rename: { nom: "name", flux: "feeds", requetes: "queries" } } },
  "notify-mail": { fields: { rename: { fournisseur: "provider", adresse: "address", motdepasse: "password", destinataire: "recipient", serveur: "server", securite: "security" }, values: { fournisseur: { autre: "other" } } } },
};

/** Les opérations YAML d'une règle, avec des chemins écrits avec les anciens noms (le document est lu avant toute retouche). */
function yamlOps(base: readonly YamlStep[], rule: Rule): YamlOp[] {
  const ops: YamlOp[] = [];
  for (const [from, to] of Object.entries(rule.rename ?? {})) ops.push({ path: base, from, to });
  for (const [key, map] of Object.entries(rule.values ?? {})) ops.push({ path: base, key, map });
  for (const [key, child] of Object.entries(rule.each ?? {})) ops.push(...yamlOps([...base, key, "*"], child));
  return ops;
}

const isTable = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Applique une règle à une table JSON, sur place. Rend les ANCIENS noms de clés changés (jamais de valeurs). */
function applyRule(obj: Record<string, unknown>, rule: Rule, where: string, conflict: (key: string) => void): string[] {
  const changed: string[] = [];
  for (const [key, map] of Object.entries(rule.values ?? {})) {
    const v = obj[key];
    if (typeof v === "string" && Object.hasOwn(map, v)) { obj[key] = map[v]; changed.push(`${where}${key}`); }
  }
  for (const [key, child] of Object.entries(rule.each ?? {})) {
    const group = obj[key];
    if (isTable(group)) for (const item of Object.values(group)) if (isTable(item)) changed.push(...applyRule(item, child, `${where}${key}.*.`, conflict));
  }
  for (const [from, to] of Object.entries(rule.rename ?? {})) {
    if (!Object.hasOwn(obj, from)) continue;
    if (Object.hasOwn(obj, to)) conflict(`${where}${from}`);
    else obj[to] = obj[from];
    delete obj[from];
    changed.push(`${where}${from}`);
  }
  return [...new Set(changed)];
}

/** Pour chaque entrée de plugin connue : son identifiant → son type de plugin (floppy.yml, puis les plugins ajoutés dans les réglages). */
function entryPlugins(env: MigrationEnv): Map<string, string> {
  const out = new Map<string, string>();
  const yml = env.read("floppy.yml");
  if (yml !== undefined) for (const e of yamlPluginEntries(yml)) out.set(e.id, e.plugin);
  const apps = env.read("items/apps.json");
  if (apps !== undefined) {
    try {
      const added = (JSON.parse(apps) as { added?: unknown }).added;
      if (isTable(added)) for (const [id, a] of Object.entries(added)) if (isTable(a) && typeof a.kind === "string" && !out.has(id)) out.set(id, a.kind);
    } catch { /* fichier illisible : rapporté par l'étape des éléments */ }
  }
  return out;
}

/** Étape 12. Configuration (`<home>/floppy.yml`) : clés et valeurs des plugins et des slots, retouchées en place (commentaires, ordre et mise en forme gardés). */
const configYaml: MigrationStep = {
  id: "config-yaml",
  version: 12,
  label: "configuration : clés et valeurs françaises de floppy.yml (famille, interets, notifications: importantes, veille.tri…) passent en anglais",
  run(env) {
    const ops: YamlOp[] = [
      { path: ["slots"], from: "veille.tri", to: "watch.triage" },
      { path: ["slots"], from: "veille.recherche", to: "watch.search" },
    ];
    for (const [plugin, rule] of Object.entries(CONFIG_RULES)) ops.push(...yamlOps(["plugins", { key: "plugin", equals: plugin }, "config"], rule));
    env.editText("floppy.yml", (text) => {
      let patch: ReturnType<typeof patchYaml>;
      try { patch = patchYaml(text, ops); } catch (e) {
        if (e instanceof YamlUnreadable) { env.skip("floppy.yml", "unreadable"); return undefined; }
        throw e;
      }
      if (!patch) return undefined;
      for (const key of patch.conflicts) env.conflict("floppy.yml", key);
      return patch.keys.length ? { text: patch.text, keys: patch.keys } : undefined;
    });
  },
};

/** Étape 13. Éléments (`<home>/items/*.json`) : champs et types français des éléments (voix locales, centres d'intérêt, boîtes mail, plugins ajoutés). */
const itemFields: MigrationStep = {
  id: "items-fields",
  version: 13,
  label: "éléments : champs et types français des fichiers items/*.json (famille, nom, flux, fournisseur, interet…) passent en anglais",
  run(env) {
    const owners = entryPlugins(env);
    for (const file of env.list("items", ".json")) {
      const name = file.slice("items/".length, -".json".length);
      env.editJson(file, (data) => {
        const changed: string[] = [];
        const conflict = (key: string) => env.conflict(file, key);
        if (name === "apps") {
          // Les plugins ajoutés (`added.<id>` : le type du plugin et sa configuration) et leurs modifications (`edits.<entrée>`).
          if (isTable(data.added)) for (const a of Object.values(data.added)) {
            const rule = isTable(a) && typeof a.kind === "string" ? CONFIG_RULES[a.kind] : undefined;
            if (rule && isTable(a) && isTable(a.values)) changed.push(...applyRule(a.values, rule, "added.values.", conflict));
          }
          if (isTable(data.edits)) for (const [id, edit] of Object.entries(data.edits)) {
            const rule = CONFIG_RULES[owners.get(id) ?? ""];
            if (rule && isTable(edit)) changed.push(...applyRule(edit, rule, "edits.", conflict));
          }
          return [...new Set(changed)];
        }
        const rules = ITEM_RULES[owners.get(name) ?? ""];
        if (!rules) return [];
        if (isTable(data.added)) for (const a of Object.values(data.added)) {
          if (!isTable(a)) continue;
          if (typeof a.kind === "string" && rules.kinds && Object.hasOwn(rules.kinds, a.kind)) { a.kind = rules.kinds[a.kind]; changed.push("added.kind"); }
          if (isTable(a.values)) changed.push(...applyRule(a.values, rules.fields, "added.values.", conflict));
        }
        if (isTable(data.edits)) for (const edit of Object.values(data.edits)) if (isTable(edit)) changed.push(...applyRule(edit, rules.fields, "edits.", conflict));
        return [...new Set(changed)];
      });
    }
  },
};

/** Étape 14. Boîte aux lettres (`<home>/inbox-apps.json`) : la confiance « non » devient `denied`. */
const inboxTrust: MigrationStep = {
  id: "inbox-trust",
  version: 14,
  label: "boîte aux lettres : la confiance « non » d'une application devient « denied »",
  run(env) {
    env.editJson("inbox-apps.json", (data) => {
      const changed: string[] = [];
      if (isTable(data.apps)) for (const app of Object.values(data.apps)) {
        if (isTable(app) && app.trust === "non") { app.trust = "denied"; changed.push("apps.trust"); }
      }
      return [...new Set(changed)];
    });
  },
};

/** Les préférences d'une veille : champs français → anglais (la valeur `+` / `-` de l'avis ne change pas). */
const PREFS_RULE: Rule = { rename: { aime: "likes", evite: "avoids", bannis: "banned", exemples: "examples" } };
const PREFS_EXAMPLE_RULE: Rule = { rename: { titre: "title", avis: "feedback" } };

/** Étape 15. Préférences de la veille (`<home>/veille/preferences.json`) : aime / evite / bannis / exemples / interets passent en anglais. */
const watchPreferences: MigrationStep = {
  id: "watch-preferences",
  version: 15,
  label: "veille : les préférences (aime, evite, bannis, exemples, interets) passent en anglais (likes, avoids, banned, examples, interests)",
  run(env) {
    env.editJson("veille/preferences.json", (data) => {
      const changed: string[] = [];
      const conflict = (key: string) => env.conflict("veille/preferences.json", key);
      const one = (prefs: unknown, where: string) => {
        if (!isTable(prefs)) return;
        // Les exemples d'abord (sous leur ancien nom) : leurs champs, puis la liste elle-même.
        if (Array.isArray(prefs.exemples)) for (const e of prefs.exemples) if (isTable(e)) changed.push(...applyRule(e, PREFS_EXAMPLE_RULE, `${where}exemples.`, conflict));
        changed.push(...applyRule(prefs, PREFS_RULE, where, conflict));
      };
      one(data.global, "global.");
      if (isTable(data.interets)) for (const p of Object.values(data.interets)) one(p, "interets.*.");
      changed.push(...applyRule(data, { rename: { interets: "interests" } }, "", conflict));
      return [...new Set(changed)];
    });
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Étapes 20 et suivantes : les noms d'outils (et de leurs arguments) passent en anglais. Un nom d'outil est écrit chez
// l'utilisateur à quelques endroits seulement ; chacun a son étape, par chemin précis. Seuls les outils que Floppy
// définit lui-même changent (voir `tool-names.ts`) : on lit le type du plugin qui porte l'entrée, jamais le nom seul.
// ---------------------------------------------------------------------------------------------------------------

/** Passe des opérations YAML sur floppy.yml (mêmes règles que l'étape de configuration : mise en forme gardée). */
function patchFloppyYml(env: MigrationEnv, ops: readonly YamlOp[]): void {
  if (!ops.length) return;
  env.editText("floppy.yml", (text) => {
    let patch: ReturnType<typeof patchYaml>;
    try { patch = patchYaml(text, ops); } catch (e) {
      if (e instanceof YamlUnreadable) { env.skip("floppy.yml", "unreadable"); return undefined; }
      throw e;
    }
    if (!patch) return undefined;
    for (const key of patch.conflicts) env.conflict("floppy.yml", key);
    return patch.keys.length ? { text: patch.text, keys: patch.keys } : undefined;
  });
}

/**
 * Étape 20. Configuration (`<home>/floppy.yml`) : les outils nommés dans les autorisations ciblées
 * (`approvals.toolRules[].tool`, selon la `source` = entrée du plugin) et l'outil de délégation du cerveau
 * (`brain-aisdk` : `delegateTool: deleguer` devient `delegate`). Les listes `include` / `levels` / `exclude` des serveurs MCP
 * (noms choisis par le serveur extérieur) ne sont jamais touchées.
 */
const toolsConfigYaml: MigrationStep = {
  id: "tools-config-yaml",
  version: 20,
  label: "configuration : les noms d'outils de Floppy (toolRules, delegateTool) passent en anglais",
  run(env) {
    const text = env.read("floppy.yml");
    if (text === undefined) return;
    const ops: YamlOp[] = [];
    let entries: { id: string; plugin: string }[];
    try { entries = yamlPluginEntries(text); } catch { env.skip("floppy.yml", "unreadable"); return; }
    const sources = new Map<string, string>(FIXED_SOURCES.map((s) => [s, s]));
    for (const e of entries) sources.set(e.id, e.plugin);
    for (const [source, type] of sources) {
      const map = TOOL_RENAMES[type];
      if (map) ops.push({ path: ["approvals", "toolRules", { key: "source", equals: source }], key: "tool", map });
    }
    ops.push({ path: ["plugins", { key: "plugin", equals: "brain-aisdk" }, "config"], key: "delegateTool", map: { deleguer: "delegate" } });
    patchFloppyYml(env, ops);
  },
};

/** Renomme les clés d'une table (ancien → nouveau) ; le nouveau gagne si les deux sont là. Rend les anciens noms changés. */
function renameKeys(obj: Record<string, unknown>, map: Readonly<Record<string, string>>, where: string, conflict: (key: string) => void): string[] {
  const changed: string[] = [];
  for (const [from, to] of Object.entries(map)) {
    if (!Object.hasOwn(obj, from)) continue;
    if (Object.hasOwn(obj, to)) conflict(`${where}${from}`); else obj[to] = obj[from];
    delete obj[from];
    changed.push(`${where}${from}`);
  }
  return changed;
}

/**
 * Étape 21. Éléments (`<home>/items/apps.json`) : les outils de chaque application (`children.<entrée>.<outil>` : interrupteur
 * par outil ; `extra.tools.<entrée>[].name` : liste mémorisée). Seules les entrées dont le plugin est un plugin de Floppy qui
 * définit l'outil sont touchées ; `items/tools.json` (serveurs MCP extérieurs) n'est jamais lu.
 */
const toolsItemsApps: MigrationStep = {
  id: "tools-items-apps",
  version: 21,
  label: "éléments : les noms d'outils de Floppy dans items/apps.json (children, extra.tools) passent en anglais",
  run(env) {
    const owners = entryPlugins(env);
    // Entrée inconnue (ni dans floppy.yml ni ajoutée) : par défaut, l'id du type (l'entrée « m365 » du plugin « m365 »).
    const typeOf = (entry: string): string => owners.get(entry) ?? entry;
    env.editJson("items/apps.json", (data) => {
      const changed: string[] = [];
      const conflict = (key: string) => env.conflict("items/apps.json", key);
      if (isTable(data.children)) for (const [entry, kids] of Object.entries(data.children)) {
        const map = TOOL_RENAMES[typeOf(entry)];
        if (map && isTable(kids)) changed.push(...renameKeys(kids, map, "children.*.", conflict));
      }
      const extra = isTable(data.extra) ? data.extra : undefined;
      if (extra && isTable(extra.tools)) for (const [entry, list] of Object.entries(extra.tools)) {
        const map = TOOL_RENAMES[typeOf(entry)];
        if (!map || !Array.isArray(list)) continue;
        for (const tool of list) if (isTable(tool) && typeof tool.name === "string" && Object.hasOwn(map, tool.name)) { tool.name = map[tool.name]; changed.push("extra.tools.*.name"); }
      }
      return [...new Set(changed)];
    });
  },
};

/**
 * Étape 22. Éléments « commande » (`<home>/items/<entrée du plugin tools>.json`) : l'emplacement de l'argument donné à l'outil
 * dans la ligne de commande passe de `{texte}` à `{text}` (`added.<id>.values.args[]`, type `command`).
 */
const toolsCommandPlaceholder: MigrationStep = {
  id: "tools-command-placeholder",
  version: 22,
  label: "éléments : l'emplacement {texte} des commandes devient {text}",
  run(env) {
    const owners = entryPlugins(env);
    for (const file of env.list("items", ".json")) {
      const entry = file.slice("items/".length, -".json".length);
      if (owners.get(entry) !== "tools") continue;
      env.editJson(file, (data) => {
        let changed = false;
        if (isTable(data.added)) for (const item of Object.values(data.added)) {
          if (!isTable(item) || item.kind !== "command" || !isTable(item.values) || !Array.isArray(item.values.args)) continue;
          item.values.args = item.values.args.map((a) => {
            if (typeof a !== "string" || !a.includes("{texte}")) return a;
            changed = true;
            return a.split("{texte}").join("{text}");
          });
        }
        return changed ? ["added.values.args"] : [];
      });
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Étapes 30 et suivantes : les identifiants de plugins, les dossiers et fichiers, la base de la veille, et les anciens
// réglages que le code lisait encore une fois (connecteur_<id>, mot_activation, orca_surveillance) passent en anglais.
// Chaque étape est complète et ne dépend du résultat partiel d'aucune autre : elle trouve ce qu'elle doit changer dans
// l'état qu'elle lit, ancien ou nouveau.
// ---------------------------------------------------------------------------------------------------------------

/** Plugins renommés : ancien identifiant → nouveau. Une entrée de floppy.yml dont l'id est exactement l'ancien identifiant (le choix par défaut) prend le nouveau ; toute autre entrée garde son id (c'est le mot de l'utilisateur). */
const PLUGIN_RENAMES: Readonly<Record<string, string>> = {
  veille: "watch", "avatar-essaim": "avatar-swarm", "avatar-goutte": "avatar-droplet", "avatar-oscillo": "avatar-neon-scope",
};
/** Identifiants d'avatar (avatar.json) : ancien → nouveau. Gardés dans `items/avatars.json` et dans la config de `body-electron`. */
const AVATAR_IDS: Readonly<Record<string, string>> = { essaim: "swarm", goutte: "droplet", oscillo: "neon-scope" };
/** Tâches de la veille : ancien identifiant → nouveau. */
const WATCH_TASKS: Readonly<Record<string, string>> = { quotidienne: "daily" };

const mapped = (map: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** Change le nom des clés d'une table (l'ordre est gardé) ; le nouveau gagne si les deux existent. Rend les anciens noms changés. */
function rekey(data: Record<string, unknown>, to: (key: string) => string | undefined, conflict: (key: string) => void): string[] {
  const changed: string[] = [];
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const dest = to(key);
    if (dest === undefined || dest === key) { if (!Object.hasOwn(next, key)) next[key] = value; continue; }
    changed.push(key);
    if (Object.hasOwn(data, dest)) { conflict(key); continue; }
    next[dest] = value;
  }
  if (!changed.length) return [];
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, next);
  return changed;
}

/** Remplace dans une liste de textes (sans doublon, ordre gardé). */
function remapList(list: unknown, to: (v: string) => string | undefined): { list: unknown; changed: boolean } {
  if (!Array.isArray(list)) return { list, changed: false };
  let changed = false;
  const out: unknown[] = [];
  for (const v of list) {
    const dest = typeof v === "string" ? to(v) : undefined;
    const value = dest ?? v;
    if (dest !== undefined && dest !== v) changed = true;
    if (!out.includes(value)) out.push(value); else changed = true;
  }
  return { list: out, changed };
}

/** Les parties d'un fichier d'éléments (`disabled`, `removed`, `edits`, `children`) qui nomment un élément dont l'identifiant change. */
function renameOverlayIds(data: Record<string, unknown>, to: (id: string) => string | undefined, conflict: (key: string) => void): string[] {
  const changed: string[] = [];
  for (const key of ["disabled", "removed"]) {
    const r = remapList(data[key], to);
    if (r.changed) { data[key] = r.list; changed.push(key); }
  }
  for (const key of ["edits", "children"]) {
    const group = data[key];
    if (isTable(group) && rekey(group, to, (k) => conflict(`${key}.${k}`)).length) changed.push(key);
  }
  return changed;
}

/**
 * Étape 30. Identifiants de plugins : la veille devient `watch`, les avatars `swarm`, `droplet` et `neon-scope`. Tout ce qui nomme
 * le plugin (`plugin:` de floppy.yml, `kind` des plugins ajoutés), l'entrée par défaut (id de l'entrée, `source` des autorisations
 * ciblées, fichier `items/<entrée>.json`, clés de `items/apps.json`, réglages `tasks.<entrée>.<tâche>`, `tasks.json`), la tâche
 * `quotidienne` (→ `daily`) et le choix d'avatar (`items/avatars.json`, `avatar:` de body-electron) change dans cette seule étape.
 * Une entrée n'est renommée que si son id est exactement l'ancien identifiant du plugin ; si le nouvel id est déjà pris par une
 * autre entrée, elle garde son id (conflit signalé) et seul le type du plugin change. floppy.yml est modifié en dernier : le plan
 * se lit dans ce fichier, et tout le reste est déjà fait quand il change.
 */
const pluginIds: MigrationStep = {
  id: "plugin-ids",
  version: 30,
  label: "plugins : la veille et les avatars (essaim, goutte, oscillo) passent en anglais (watch, swarm, droplet, neon-scope), avec leurs entrées, tâche et fichiers",
  run(env) {
    const owners = entryPlugins(env);
    const taken = new Set(owners.keys());
    // Les entrées par défaut à renommer : id = ancien identifiant du plugin.
    const entryNew = new Map<string, string>();
    for (const [id, plugin] of owners) {
      const to = mapped(PLUGIN_RENAMES, plugin);
      if (to === undefined || id !== plugin) continue;
      if (taken.has(to)) { env.conflict("floppy.yml", `plugins[${id}].id`, "both"); continue; }
      entryNew.set(id, to);
    }
    const entryTo = (id: string): string => entryNew.get(id) ?? id;
    const taskTo = (entry: string, task: string): string => (owners.get(entry) === "veille" ? mapped(WATCH_TASKS, task) ?? task : task);

    // 1. Les tâches : `tasks.json` (« entrée/tâche ») et les réglages (`tasks.<entrée>.<tâche>[.send]`).
    env.editJson("tasks.json", (data) => rekey(data, (key) => {
      const i = key.indexOf("/");
      if (i < 0) return undefined;
      const entry = key.slice(0, i);
      return `${entryTo(entry)}/${taskTo(entry, key.slice(i + 1))}`;
    }, (key) => env.conflict("tasks.json", key)));
    env.editJson("settings.json", (data) => rekey(data, (key) => {
      const parts = key.split(".");
      if (parts[0] !== "tasks" || parts.length < 3) return undefined;
      return ["tasks", entryTo(parts[1]!), taskTo(parts[1]!, parts[2]!), ...parts.slice(3)].join(".");
    }, (key) => env.conflict("settings.json", key)));

    // 2. Le fichier d'éléments de chaque entrée renommée.
    for (const [from, to] of entryNew) env.renamePath(`items/${from}.json`, `items/${to}.json`);

    // 3. `items/apps.json` : plugins ajoutés (type, id, avatar choisi), entrées désactivées, retirées, modifiées, outils.
    env.editJson("items/apps.json", (data) => {
      const changed: string[] = [];
      const conflict = (key: string) => env.conflict("items/apps.json", key);
      const avatarRule: Rule = { values: { avatar: AVATAR_IDS } };
      if (isTable(data.added)) {
        for (const a of Object.values(data.added)) {
          if (!isTable(a)) continue;
          const kind = typeof a.kind === "string" ? mapped(PLUGIN_RENAMES, a.kind) : undefined;
          if (kind !== undefined) { a.kind = kind; changed.push("added.kind"); }
          if (a.kind === "body-electron" && isTable(a.values)) changed.push(...applyRule(a.values, avatarRule, "added.values.", conflict));
        }
        if (rekey(data.added, (id) => entryNew.get(id), (k) => conflict(`added.${k}`)).length) changed.push("added");
      }
      changed.push(...renameOverlayIds(data, (id) => entryNew.get(id), conflict));
      if (isTable(data.edits)) for (const [id, edit] of Object.entries(data.edits)) {
        if (owners.get(id) === "body-electron" && isTable(edit)) changed.push(...applyRule(edit, avatarRule, "edits.", conflict));
      }
      if (isTable(data.extra) && isTable(data.extra.tools) && rekey(data.extra.tools, (id) => entryNew.get(id), (k) => conflict(`extra.tools.${k}`)).length) changed.push("extra.tools");
      return [...new Set(changed)];
    });

    // 4. `items/avatars.json` : l'avatar choisi et ceux qui sont mis de côté.
    env.editJson("items/avatars.json", (data) => {
      const changed: string[] = [];
      const to = (id: string) => mapped(AVATAR_IDS, id);
      if (isTable(data.extra) && typeof data.extra.current === "string" && to(data.extra.current) !== undefined) { data.extra.current = to(data.extra.current); changed.push("extra.current"); }
      changed.push(...renameOverlayIds(data, to, (key) => env.conflict("items/avatars.json", key)));
      return changed;
    });

    // 5. floppy.yml, en dernier : type du plugin, id des entrées renommées, `source` des autorisations ciblées, avatar de body-electron.
    const ops: YamlOp[] = [{ path: ["plugins", "*"], key: "plugin", map: PLUGIN_RENAMES }];
    for (const [from, to] of entryNew) ops.push({ path: ["plugins", { key: "plugin", equals: from }], key: "id", map: { [from]: to } });
    if (entryNew.size) ops.push({ path: ["approvals", "toolRules", "*"], key: "source", map: Object.fromEntries(entryNew) });
    ops.push({ path: ["plugins", { key: "plugin", equals: "body-electron" }, "config"], key: "avatar", map: AVATAR_IDS });
    patchFloppyYml(env, ops);
  },
};

/**
 * Étape 31. Dossier de la veille : `<home>/veille/` devient `<home>/watch/`, sa base `veille.db` devient `watch.db` (avec ses
 * fichiers du moment, `-journal`, `-wal`, `-shm`). La base est renommée d'abord, là où elle est, pour que le rapport à blanc dise tout
 * et qu'une étape tronquée reparte sans dépendre d'un résultat partiel. Le dossier est déplacé d'un bloc, jamais écrasé : si
 * `watch/` existe déjà, rien ne bouge et le conflit est signalé.
 */
const watchFolder: MigrationStep = {
  id: "watch-folder",
  version: 31,
  label: "veille : le dossier veille/ devient watch/ et sa base veille.db devient watch.db",
  run(env) {
    for (const dir of ["veille", "watch"]) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) env.renamePath(`${dir}/veille.db${suffix}`, `${dir}/watch.db${suffix}`);
    }
    env.renamePath("veille", "watch");
  },
};

/** Les places possibles de la base de la veille, quel que soit l'avancement de l'étape précédente. */
const WATCH_DATABASES = ["watch/watch.db", "watch/veille.db", "veille/watch.db", "veille/veille.db"];

/**
 * Étape 32. Base de la veille (SQLite) : table `vus` → `seen` (colonnes `titre` → `title`, `interet` → `interest`, `vu_le` → `seen_at`),
 * table `digest` (colonnes `numero` → `number`, `interet`, `titre`, `resume` → `summary`). Une copie `<base>.bak-watch-database`
 * est écrite avant le premier changement ; les renommages sont dans une transaction. Base absente ou déjà au nouveau format :
 * intacte. Base verrouillée ou illisible : l'étape échoue et repart au prochain démarrage.
 */
const watchDatabase: MigrationStep = {
  id: "watch-database",
  version: 32,
  label: "veille : tables et colonnes de la base (vus, titre, interet, resume, numero, vu_le) passent en anglais",
  run(env) {
    for (const file of WATCH_DATABASES) {
      env.editSqlite(file, (db) => {
        db.renameTable("vus", "seen");
        db.renameColumn("seen", "titre", "title");
        db.renameColumn("seen", "interet", "interest");
        db.renameColumn("seen", "vu_le", "seen_at");
        db.renameColumn("digest", "numero", "number");
        db.renameColumn("digest", "interet", "interest");
        db.renameColumn("digest", "titre", "title");
        db.renameColumn("digest", "resume", "summary");
      });
    }
  },
};

/** Étiquettes des documents : ancien → nouveau. */
const DOCUMENT_TAGS: Readonly<Record<string, string>> = { veille: "watch", reponse: "answer" };

/**
 * Étape 33. Documents (`<home>/documents/*.md`) : dans l'en-tête, `source: "veille"` devient `"watch"` et les étiquettes
 * `veille` / `reponse` de `tags:` deviennent `watch` / `answer`. Le reste du fichier, le titre et le nom du fichier ne changent pas.
 */
const documentTags: MigrationStep = {
  id: "documents-tags",
  version: 33,
  label: "documents : la source et l'étiquette « veille » deviennent « watch », l'étiquette « reponse » devient « answer »",
  run(env) {
    for (const file of env.list("documents", ".md")) {
      env.editText(file, (text) => {
        const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
        if (!m) return undefined;
        const keys: string[] = [];
        let head = m[2]!;
        head = head.replace(/^(source:[ \t]*)"veille"([ \t]*)$/m, (_all, a: string, b: string) => { keys.push("source"); return `${a}"watch"${b}`; });
        head = head.replace(/^(tags:[ \t]*)(\[.*\])([ \t]*)$/m, (all, a: string, list: string, b: string) => {
          let tags: unknown;
          try { tags = JSON.parse(list); } catch { return all; }
          const r = remapList(tags, (t) => mapped(DOCUMENT_TAGS, t));
          if (!r.changed) return all;
          keys.push("tags");
          return `${a}${JSON.stringify(r.list)}${b}`;
        });
        return keys.length ? { text: m[1] + head + text.slice(m[1]!.length + m[2]!.length), keys } : undefined;
      });
    }
  },
};

/**
 * Étape 34. Dossiers et fichiers que Floppy écrit sous son répertoire de travail : les dossiers de travail du plugin `coder`
 * (`workspaces/coder/reglages` → `settings`, `revues` → `reviews`), l'enregistrement d'essai d'une voix (`tts-audiocpp/essai.wav` →
 * `trial.wav`) et la copie de l'exemple du kit de développement (`plugins/exemple-minuteur` → `example-timer`).
 */
const folders: MigrationStep = {
  id: "folders",
  version: 34,
  label: "dossiers et fichiers : workspaces/coder/reglages et revues, tts-audiocpp/essai.wav, plugins/exemple-minuteur passent en anglais",
  run(env) {
    env.renamePath("workspaces/coder/reglages", "workspaces/coder/settings");
    env.renamePath("workspaces/coder/revues", "workspaces/coder/reviews");
    env.renamePath("tts-audiocpp/essai.wav", "tts-audiocpp/trial.wav");
    env.renamePath("plugins/exemple-minuteur", "plugins/example-timer");
  },
};

/** Les entrées d'un type de plugin : id et configuration (floppy.yml, puis les plugins ajoutés dans `items/apps.json`). */
function entriesOf(env: MigrationEnv, type: string): { id: string; config: Record<string, unknown> }[] {
  const out = new Map<string, Record<string, unknown>>();
  const yml = env.read("floppy.yml");
  if (yml !== undefined) for (const e of yamlPluginEntries(yml)) if (e.plugin === type) out.set(e.id, e.config ?? {});
  const apps = env.read("items/apps.json");
  if (apps !== undefined) {
    try {
      const added = (JSON.parse(apps) as { added?: unknown }).added;
      if (isTable(added)) for (const [id, a] of Object.entries(added)) if (isTable(a) && a.kind === type && !out.has(id)) out.set(id, isTable(a.values) ? a.values : {});
    } catch { /* fichier illisible : rapporté par les autres étapes */ }
  }
  return [...out].map(([id, config]) => ({ id, config }));
}

/** Les réglages de `settings.json`, en lecture seule ; absent ou illisible : table vide. */
function readSettings(env: MigrationEnv): Record<string, unknown> {
  const text = env.read("settings.json");
  if (text === undefined) return {};
  try { const data = JSON.parse(text) as unknown; return isTable(data) ? data : {}; } catch { return {}; }
}

/** Retire des clés de `settings.json` (sans elles, plus rien ne les lit). */
function dropSettings(env: MigrationEnv, drop: (key: string) => boolean): void {
  env.editJson("settings.json", (data) => {
    const gone = Object.keys(data).filter(drop);
    for (const key of gone) delete data[key];
    return gone;
  });
}

/**
 * Étape 35. Connecteurs (plugin `tools`) : les anciens réglages `connecteur_<id>` (allumé / éteint) passent dans le fichier d'éléments
 * de l'entrée (`items/<entrée>.json` : `disabled` pour un éteint, `extra.enabled` pour un allumé que la config laissait éteint),
 * une seule fois (`extra.migrated`). Les réglages sont ensuite retirés de `settings.json`. Remplace la reprise qui était dans le code du plugin.
 */
const connectorSettings: MigrationStep = {
  id: "connectors-settings",
  version: 35,
  label: "connecteurs : les réglages connecteur_<id> passent dans les éléments de l'entrée (disabled, extra.enabled)",
  run(env) {
    const legacy = Object.entries(readSettings(env)).filter(([key]) => key.startsWith("connecteur_"));
    if (!legacy.length) return;
    const saved = new Map(legacy);
    for (const entry of entriesOf(env, "tools")) {
      env.editJson(`items/${entry.id}.json`, (data) => {
        const extra = isTable(data.extra) ? data.extra : {};
        if (extra.migrated === true) return [];
        const servers = isTable(entry.config.servers) ? Object.keys(entry.config.servers) : [];
        const added = isTable(data.added) ? Object.keys(data.added) : [];
        const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        let disabled = strings(data.disabled);
        let enabled = strings(extra.enabled);
        let any = false;
        for (const id of [...servers, ...added]) {
          const old = saved.get(`connecteur_${id.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`);
          if (typeof old !== "boolean") continue;
          any = true;
          disabled = disabled.filter((d) => d !== id);
          enabled = enabled.filter((d) => d !== id);
          if (old) enabled.push(id); else disabled.push(id);
        }
        if (!any) return [];
        data.disabled = disabled;
        data.extra = { ...extra, enabled, migrated: true };
        return ["disabled", "extra.enabled", "extra.migrated"];
      }, { create: true });
    }
    dropSettings(env, (key) => key.startsWith("connecteur_"));
  },
};

/**
 * Étape 36. Mot d'activation (plugin `wakeword-stt`) : l'ancien réglage `mot_activation` (mots séparés par « , » ou « ; », qui appartenait à la
 * conversation) devient la liste `edits.account.words` du fichier d'éléments de chaque entrée dont la config ne donne pas de `words` (un
 * choix déjà fait dans la fenêtre gagne). Le réglage est ensuite retiré de `settings.json`. Remplace la reprise qui était dans le code du plugin.
 */
const wakeWords: MigrationStep = {
  id: "wakeword-words",
  version: 36,
  label: "mot d'activation : le réglage mot_activation passe dans les éléments de l'entrée (edits.account.words)",
  run(env) {
    const legacy = readSettings(env).mot_activation;
    if (legacy === undefined) return;
    const words = typeof legacy === "string" ? legacy.split(/[,;]/).map((w) => w.trim()).filter(Boolean) : [];
    if (words.length) for (const entry of entriesOf(env, "wakeword-stt")) {
      if (entry.config.words !== undefined) continue;
      env.editJson(`items/${entry.id}.json`, (data) => {
        const edits = isTable(data.edits) ? data.edits : {};
        const account = isTable(edits.account) ? edits.account : {};
        if (account.words !== undefined) return [];
        data.edits = { ...edits, account: { ...account, words } };
        return ["edits.account.words"];
      }, { create: true });
    }
    dropSettings(env, (key) => key === "mot_activation");
  },
};

/**
 * Étape 37. Orca : l'ancien réglage `orca_surveillance` (booléen) : éteint, il devient `orca_notifications: "none"` (annonces coupées,
 * la collecte reste active) si ce choix n'était pas déjà fait ; allumé, il ne change rien. Le réglage est ensuite retiré de `settings.json`.
 */
const orcaSurveillance: MigrationStep = {
  id: "orca-surveillance",
  version: 37,
  label: "Orca : le réglage orca_surveillance éteint devient orca_notifications « none »",
  run(env) {
    env.editJson("settings.json", (data) => {
      if (!Object.hasOwn(data, "orca_surveillance")) return [];
      const changed = ["orca_surveillance"];
      if (data.orca_notifications === undefined && data.orca_surveillance === false) { data.orca_notifications = "none"; changed.push("orca_notifications"); }
      delete data.orca_surveillance;
      return changed;
    });
  },
};

/** Toutes les étapes, dans l'ordre. */
export const HOME_MIGRATIONS: readonly MigrationStep[] = [documentTitle, onboardingLevel, onboardingSelection, settingsKeys, settingsValues, configYaml, itemFields, inboxTrust, watchPreferences,
  toolsConfigYaml, toolsItemsApps, toolsCommandPlaceholder,
  pluginIds, watchFolder, watchDatabase, documentTags, folders, connectorSettings, wakeWords, orcaSurveillance];

/** Passe les étapes en attente sur ce répertoire de travail (au démarrage, ou `floppy migrate`). Ne lève jamais. */
export function migrateHome(home: string, opts: MigrationOptions = {}): MigrationReport[] {
  return runHomeMigrations(home, HOME_MIGRATIONS, opts);
}
