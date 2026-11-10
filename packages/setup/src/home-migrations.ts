// Les étapes de migration du répertoire de travail (le moteur est dans @floppy/core : `runHomeMigrations`).
// Une étape par changement de nom d'un identifiant que Floppy a déjà écrit chez l'utilisateur : elle convertit le
// fichier une fois, le code ne lit ensuite que les nouveaux noms (pas de « les deux noms pour toujours »).
// Ajouter une étape : une entrée de plus (version suivante), idempotente, qui rapporte des noms de clés (jamais des valeurs).
// Non migrés, par choix : l'audit (`audit.jsonl`) est un journal, les nouveaux enregistrements portent les nouveaux noms.
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

/** Toutes les étapes, dans l'ordre. */
export const HOME_MIGRATIONS: readonly MigrationStep[] = [documentTitle, onboardingLevel, onboardingSelection, settingsKeys, settingsValues, configYaml, itemFields, inboxTrust, watchPreferences];

/** Passe les étapes en attente sur ce répertoire de travail (au démarrage, ou `floppy migrate`). Ne lève jamais. */
export function migrateHome(home: string, opts: MigrationOptions = {}): MigrationReport[] {
  return runHomeMigrations(home, HOME_MIGRATIONS, opts);
}
