// Les étapes de migration livrées : en-tête des documents, niveau du premier lancement, puis réglages, configuration, éléments, boîte aux lettres et préférences de la veille.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ItemStore, readMigrationMarker, runHomeMigrations } from "@floppy/core";
import { WatchDb } from "../../../plugins/watch/digest/src/store.ts";
import { HOME_MIGRATIONS, migrateHome } from "../src/index.ts";
import { scheduleToEnglish } from "../src/home-migrations.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "floppy-home-migrations-")); mkdirSync(join(home, "documents")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const read = (rel: string) => readFileSync(join(home, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(home, rel), text);

/** Passe les étapes jusqu'à celle-là incluse (les suivantes ne touchent pas encore au fichier). */
const only = (id: string) => runHomeMigrations(home, HOME_MIGRATIONS.slice(0, HOME_MIGRATIONS.findIndex((x) => x.id === id) + 1));

const OLD_DOC = '---\ntitre: "Veille du jour"\ndate: 2026-11-06T08:00:00.000Z\nsource: "veille"\ntags: ["veille"]\n---\n\n# Corps\n\ntitre: ceci est du texte, pas l\'en-tête\n';

describe("étape documents-title", () => {
  it("renomme la clé d'en-tête `titre`, garde le reste octet pour octet, sauvegarde l'original", () => {
    write("documents/2026-11-06-0800-veille.md", OLD_DOC);
    const r = [step("documents-title")];
    expect(r.find((x) => x.step === "documents-title")!.changes).toEqual([{ file: "documents/2026-11-06-0800-veille.md", keys: ["titre"] }]);
    expect(read("documents/2026-11-06-0800-veille.md")).toBe(OLD_DOC.replace('---\ntitre:', '---\ntitle:'));
    expect(read("documents/2026-11-06-0800-veille.md.bak-documents-title")).toBe(OLD_DOC);
    // La sauvegarde ne finit pas par .md : le plugin des documents ne la liste pas.
    expect("documents/2026-11-06-0800-veille.md.bak-documents-title".endsWith(".md")).toBe(false);
  });

  it("garde les fins de ligne CRLF", () => {
    write("documents/a.md", '---\r\ntitre: "A"\r\ndate: 2026-11-06T08:00:00.000Z\r\n---\r\n\r\ncorps\r\n');
    migrateHome(home);
    expect(read("documents/a.md")).toBe('---\r\ntitle: "A"\r\ndate: 2026-11-06T08:00:00.000Z\r\n---\r\n\r\ncorps\r\n');
  });

  it("deuxième passage : sans effet (marqueur), et sans marqueur (rejeu forcé) : fichier déjà converti intact", () => {
    write("documents/a.md", OLD_DOC);
    migrateHome(home);
    const once = read("documents/a.md");
    expect(migrateHome(home).every((r) => r.alreadyApplied)).toBe(true);
    const forced = migrateHome(home, { force: true });
    expect(forced.find((x) => x.step === "documents-title")!.changes).toEqual([]);
    expect(read("documents/a.md")).toBe(once);
  });

  it("fichier déjà au nouveau format, sans en-tête, ou avec les deux clés : laissé tel quel", () => {
    const fresh = '---\ntitle: "Déjà"\ndate: 2026-11-06T08:00:00.000Z\n---\n\ncorps\n';
    const plain = "# Sans en-tête\n\ntitre: texte\n";
    const both = '---\ntitre: "Ancien"\ntitle: "Nouveau"\n---\n\ncorps\n';
    write("documents/fresh.md", fresh); write("documents/plain.md", plain); write("documents/both.md", both);
    const r = migrateHome(home).find((x) => x.step === "documents-title")!;
    expect(r.changes).toEqual([]);
    expect(r.skipped).toEqual([{ file: "documents/both.md", why: "conflict" }]);
    expect([read("documents/fresh.md"), read("documents/plain.md"), read("documents/both.md")]).toEqual([fresh, plain, both]);
  });

  it("dossier documents absent : rien à faire", () => {
    rmSync(join(home, "documents"), { recursive: true });
    expect(migrateHome(home).find((x) => x.step === "documents-title")).toMatchObject({ changes: [], skipped: [], alreadyApplied: false });
    expect(migrateHome(home).find((x) => x.step === "documents-title")!.error).toBeUndefined();
  });
});

describe("étape onboarding-level", () => {
  it("convertit les niveaux texte / voix / hybride, garde les autres clés, sauvegarde", () => {
    for (const [old, now] of [["texte", "text"], ["voix", "voice"], ["hybride", "hybrid"]] as const) {
      rmSync(join(home, "onboarding.json.bak-onboarding-level"), { force: true });
      rmSync(join(home, "migrations.json"), { force: true });
      write("onboarding.json", JSON.stringify({ done: false, level: old, brain: "claude-cli/claude" }));
      const r = only("onboarding-level").find((x) => x.step === "onboarding-level")!;
      expect(r.changes).toEqual([{ file: "onboarding.json", keys: ["level"] }]);
      expect(JSON.parse(read("onboarding.json"))).toEqual({ done: false, level: now, brain: "claude-cli/claude" });
      expect(JSON.parse(read("onboarding.json.bak-onboarding-level")).level).toBe(old);
    }
  });

  it("niveau déjà en anglais, `local`, ou absent : fichier intact ; fichier absent : rien", () => {
    for (const body of [{ done: true, level: "voice" }, { done: true, level: "local-max" }, { done: false }]) {
      rmSync(join(home, "migrations.json"), { force: true });
      write("onboarding.json", JSON.stringify(body));
      expect(only("onboarding-level").find((x) => x.step === "onboarding-level")!.changes).toEqual([]);
      expect(JSON.parse(read("onboarding.json"))).toEqual(body);
    }
    rmSync(join(home, "onboarding.json")); rmSync(join(home, "migrations.json"));
    expect(only("onboarding-level").find((x) => x.step === "onboarding-level")).toMatchObject({ changes: [], skipped: [] });
  });

  it("fichier abîmé : laissé tel quel, non déplacé", () => {
    write("onboarding.json", '{ "done": false, "level": "texte"');
    const r = only("onboarding-level").find((x) => x.step === "onboarding-level")!;
    expect(r.skipped).toEqual([{ file: "onboarding.json", why: "unreadable" }]);
    expect(read("onboarding.json")).toBe('{ "done": false, "level": "texte"');
  });
});


describe("étape onboarding-selection", () => {
  it("retire `level` et `brain`, garde le reste, sauvegarde l'original", () => {
    write("onboarding.json", JSON.stringify({ done: false, level: "local", brain: "claude-cli/claude" }));
    const r = only("onboarding-selection").find((x) => x.step === "onboarding-selection")!;
    expect(r.changes).toEqual([{ file: "onboarding.json", keys: ["level", "brain"] }]);
    expect(JSON.parse(read("onboarding.json"))).toEqual({ done: false });
    expect(JSON.parse(read("onboarding.json.bak-onboarding-selection"))).toEqual({ done: false, level: "local", brain: "claude-cli/claude" });
  });

  it("installation terminée : `done`, `at` et `skipped` restent ; la suite des étapes mène un ancien `texte` jusqu'à la fin", () => {
    write("onboarding.json", JSON.stringify({ done: true, level: "texte", at: "2026-11-07T10:00:00.000Z" }));
    migrateHome(home);
    expect(JSON.parse(read("onboarding.json"))).toEqual({ done: true, at: "2026-11-07T10:00:00.000Z" });
  });

  it("déjà au nouveau format (`selection`), ou fichier absent ou abîmé : rien n'est touché", () => {
    const body = { done: false, selection: { brain: "claude/sonnet", stt: "sherpa-library/parakeet-tdt-v3-int8" } };
    write("onboarding.json", JSON.stringify(body));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")!.changes).toEqual([]);
    expect(JSON.parse(read("onboarding.json"))).toEqual(body);
    rmSync(join(home, "onboarding.json")); rmSync(join(home, "migrations.json"));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")).toMatchObject({ changes: [], skipped: [] });
    write("onboarding.json", '{ "done": false, "level": "local"');
    rmSync(join(home, "migrations.json"));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")!.skipped).toEqual([{ file: "onboarding.json", why: "unreadable" }]);
    expect(read("onboarding.json")).toBe('{ "done": false, "level": "local"');
  });
});

describe("marqueur", () => {
  it("note chaque étape et la version la plus haute ; à blanc, rien n'est écrit", () => {
    write("documents/a.md", OLD_DOC);
    const dry = migrateHome(home, { dryRun: true });
    expect(dry.find((r) => r.step === "documents-title")!.changes).toEqual([{ file: "documents/a.md", keys: ["titre"] }]);
    expect(existsSync(join(home, "migrations.json"))).toBe(false);
    expect(read("documents/a.md")).toBe(OLD_DOC);
    migrateHome(home);
    const marker = readMigrationMarker(home);
    expect(marker.version).toBe(Math.max(...HOME_MIGRATIONS.map((s) => s.version)));
    expect(Object.keys(marker.applied).sort()).toEqual(HOME_MIGRATIONS.map((s) => s.id).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Étapes 10 à 15 : réglages, configuration, éléments, boîte aux lettres, préférences de la veille.
// ---------------------------------------------------------------------------------------------------------------

const json = (rel: string) => JSON.parse(read(rel)) as Record<string, any>;
const put = (rel: string, data: unknown) => { mkdirSync(join(home, rel, ".."), { recursive: true }); writeFileSync(join(home, rel), JSON.stringify(data, null, 2)); };
/** Passe UNE étape (les autres ne tournent pas : on voit ce que celle-ci change). */
const step = (id: string, opts: { dryRun?: boolean; force?: boolean } = {}) => runHomeMigrations(home, HOME_MIGRATIONS.filter((s) => s.id === id), opts)[0]!;

describe("étape settings-keys", () => {
  const OLD = {
    avatar_visible: true, ton: "un peu sarcastique", ecoute_libre: 12, expressivite: "natural", langue_interface: "en", langue_assistant: "fr",
    dossier_floppy: "C:/travail", masquer_apres: 15, bulle: false, toujours_devant: true, demarrage_windows: true,
    raccourci_parler: "Ctrl+Alt+F", raccourci_ecrire: "Ctrl+Alt+T", raccourci_dicter: "", raccourci_dormir: "Ctrl+Alt+M", raccourci_avatar: "Ctrl+Alt+H",
    llm_local_programme: "C:/llama-server.exe", llm_local_dossiers: "C:/models", tts_local_programme: "C:/audio.exe", tts_local_dossiers: "C:/voices",
    assistant_modele_claude: "opus", plugins_tiers_relecteur: "codex", orca_notifications: "toutes",
    "slot.brain.main": "brain-codex-cli/codex", "slot.veille.tri": "claude/sonnet", "slot.veille.recherche": "websearch/claude",
    "taches.veille.quotidienne": "07:30 lun-ven", "taches.veille.quotidienne.envoi": "Telegram",
    cerveau: "x", voix: "femme", "service.live": "@none",
  };

  it("renomme chaque clé, garde les valeurs, les autres clés et leur ordre, supprime les trois clés orphelines, sauvegarde", () => {
    put("settings.json", OLD);
    const r = step("settings-keys");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.file).toBe("settings.json");
    expect(r.changes[0]!.keys.sort()).toEqual(Object.keys(OLD).filter((k) => !["avatar_visible", "slot.brain.main", "orca_notifications"].includes(k)).sort());
    expect(json("settings.json")).toEqual({
      avatar_visible: true, tone: "un peu sarcastique", free_listen_s: 12, expressiveness: "natural", ui_language: "en", assistant_language: "fr",
      home_folder: "C:/travail", hide_after: 15, bubble: false, always_on_top: true, autostart: true,
      shortcut_talk: "Ctrl+Alt+F", shortcut_write: "Ctrl+Alt+T", shortcut_dictate: "", shortcut_sleep: "Ctrl+Alt+M", shortcut_avatar: "Ctrl+Alt+H",
      llm_local_program: "C:/llama-server.exe", llm_local_folders: "C:/models", tts_local_program: "C:/audio.exe", tts_local_folders: "C:/voices",
      assistant_claude_model: "opus", third_party_plugins_reviewer: "codex", orca_notifications: "toutes",
      "slot.brain.main": "brain-codex-cli/codex", "slot.watch.triage": "claude/sonnet", "slot.watch.search": "websearch/claude",
      "tasks.veille.quotidienne": "07:30 lun-ven", "tasks.veille.quotidienne.send": "Telegram",
    });
    // (les valeurs sont celles de l'étape suivante)
    expect(Object.keys(json("settings.json")).slice(0, 3)).toEqual(["avatar_visible", "tone", "free_listen_s"]);
    expect(json("settings.json.bak-settings-keys")).toEqual(OLD);
    expect(r.conflicts).toBeUndefined();
  });

  it("les deux noms présents : le nouveau est gardé, l'ancien retiré, le conflit est rapporté (nom de la clé seulement)", () => {
    put("settings.json", { ton: "ancien", tone: "nouveau", bulle: true });
    const r = step("settings-keys");
    expect(json("settings.json")).toEqual({ tone: "nouveau", bubble: true });
    expect(r.conflicts).toEqual([{ file: "settings.json", key: "ton" }]);
    expect(r.changes[0]!.keys.sort()).toEqual(["bulle", "ton"]);
    expect(JSON.stringify(r)).not.toContain("ancien");
  });

  it("déjà converti, ou sans clé à changer : fichier intact, sans sauvegarde ; fichier absent ou abîmé : rien", () => {
    put("settings.json", { tone: "x", hide_after: 3, "tasks.veille.quotidienne": "08:00", plugin_installer_x: true });
    expect(step("settings-keys").changes).toEqual([]);
    expect(existsSync(join(home, "settings.json.bak-settings-keys"))).toBe(false);
    rmSync(join(home, "settings.json")); rmSync(join(home, "migrations.json"));
    expect(step("settings-keys")).toMatchObject({ changes: [], skipped: [] });
    write("settings.json", '{ "ton": "x"'); rmSync(join(home, "migrations.json"));
    expect(step("settings-keys").skipped).toEqual([{ file: "settings.json", why: "unreadable" }]);
    expect(read("settings.json")).toBe('{ "ton": "x"');
  });

  it("à blanc : rapporte les noms des clés, sans rien écrire", () => {
    put("settings.json", { ton: "secret perso", demarrage_windows: true });
    const r = step("settings-keys", { dryRun: true });
    expect(r.changes).toEqual([{ file: "settings.json", keys: ["ton", "demarrage_windows"] }]);
    expect(JSON.stringify(r)).not.toContain("secret perso");
    expect(json("settings.json")).toEqual({ ton: "secret perso", demarrage_windows: true });
    expect(existsSync(join(home, "settings.json.bak-settings-keys"))).toBe(false);
  });
});

describe("étape settings-values", () => {
  it("valeurs d'Orca, confiance des applications, planifications et canaux d'envoi des tâches", () => {
    put("settings.json", {
      orca_notifications: "importantes",
      inbox_app_differendum: "non", inbox_app_autre: "app", inbox_app_info: "info",
      "tasks.veille.quotidienne": "07:30 lun,jeu", "tasks.veille.quotidienne.send": "nulle part", "tasks.a.b": "toutes les 30 min", "tasks.a.c": "toutes les 3h", "tasks.a.d": "jamais",
      "tasks.a.e": "à 8h30", "tasks.a.e.send": "Mon canal, Gmail", "tasks.a.f": "07:30 lun-ven", "tasks.a.g": "09:00 sam,dim",
      plugin_x: "non", hide_after: 3,
    });
    const r = step("settings-values");
    expect(r.changes).toEqual([{ file: "settings.json", keys: ["orca_notifications", "inbox_app_differendum", "tasks.veille.quotidienne", "tasks.veille.quotidienne.send", "tasks.a.b", "tasks.a.c", "tasks.a.d", "tasks.a.f", "tasks.a.g"] }]);
    expect(json("settings.json")).toEqual({
      orca_notifications: "important",
      inbox_app_differendum: "denied", inbox_app_autre: "app", inbox_app_info: "info",
      "tasks.veille.quotidienne": "07:30 mon,thu", "tasks.veille.quotidienne.send": "nowhere", "tasks.a.b": "every 30 min", "tasks.a.c": "every 3h", "tasks.a.d": "never",
      // Autres écritures : laissées (le lecteur de planification les comprend toujours, en français comme en anglais).
      "tasks.a.e": "à 8h30", "tasks.a.e.send": "Mon canal, Gmail", "tasks.a.f": "07:30 mon-fri", "tasks.a.g": "09:00 sat,sun",
      plugin_x: "non", hide_after: 3,
    });
    expect(json("settings.json.bak-settings-values").orca_notifications).toBe("importantes");
  });

  it("les trois valeurs d'Orca ; déjà converti : intact", () => {
    for (const [old, now] of [["toutes", "all"], ["importantes", "important"], ["aucune", "none"]] as const) {
      rmSync(join(home, "migrations.json"), { force: true });
      put("settings.json", { orca_notifications: old });
      expect(step("settings-values").changes).toHaveLength(1);
      expect(json("settings.json")).toEqual({ orca_notifications: now });
      rmSync(join(home, "migrations.json"), { force: true });
      expect(step("settings-values").changes).toEqual([]);
    }
  });

  it("enchaînée avec les clés : une ancienne clé de tâche est renommée puis sa valeur convertie, en un seul passage", () => {
    put("settings.json", { "taches.veille.quotidienne": "toutes les 3h", "taches.veille.quotidienne.envoi": "nulle part" });
    migrateHome(home);
    expect(json("settings.json")).toEqual({ "tasks.veille.quotidienne": "every 3h", "tasks.veille.quotidienne.send": "nowhere" });
  });

  it("scheduleToEnglish : seulement les écritures de l'ancien code", () => {
    expect(["jamais", "toutes les 3h", "toutes les 30 min", "07:30", "07:30 lun-ven", "09:00 lun,jeu,sam,dim", "07:30 lun-xxx", "plus tard"].map(scheduleToEnglish))
      .toEqual(["never", "every 3h", "every 30 min", undefined, "07:30 mon-fri", "09:00 mon,thu,sat,sun", undefined, undefined]);
  });
});

/** Un floppy.yml comme l'écrit un utilisateur : commentaires, lignes vides, ancre, guillemets, flux, plugins non renommés. */
const YML = `# Mon floppy.yml : mes notes à moi
assistant:
  name: Floppy   # le nom d'activation

slots:
  brain.main: llm/gemma
  veille.tri: claude/sonnet            # le cerveau du tri
  "veille.recherche": websearch/claude

approvals: { read: always }

plugins:
  # --- Voix
  - id: tts-local
    plugin: tts-audiocpp
    config:
      port: 8089
      models:
        femme: &base   # voix de base
          label: Floppy
          "famille": pocket_tts
          voix: clone    # clone ou integree
          refWav: C:/x/ref.wav
        anna:
          label: Anna
          famille: qwen3_tts
          voix: 'integree'
          speaker: ono_anna
          langue: fr

        copie: *base
  - { id: orca, plugin: orca, config: { pollSeconds: 15, notifications: importantes } }   # Orca
  - { id: orca2, plugin: orca-autre, config: { notifications: importantes, famille: x } }

  # --- Veille
  - id: veille
    plugin: veille
    config:
      seuil: 7
      lot: 10
      maxVersModele: 40
      fenetreJours: 3
      interets:
        ia-locale:
          nom: IA locale     # mon sujet
          description: "Garde nom, flux et famille dans ce texte"
          flux:
            - https://a.example/atom
          requetes: [llama.cpp]
          max: 5
  - id: sched
    plugin: scheduler
    config: { delaiDemarrageS: 30 }
  - id: sx
    plugin: searxng
    config:
      langue: "fr"
  - id: ses
    plugin: agent-sessions
    config:
      dossier: ~/Travaux
  - id: inconnu
    plugin: contoso
    config:
      famille: x    # pas à moi
      nom: y
      interets: [a]
`;

describe("étape config-yaml", () => {
  it("renomme les clés et les valeurs visées, et rien d'autre : commentaires, lignes vides, ancre, guillemets, flux, plugins inconnus intacts", () => {
    write("floppy.yml", YML);
    const r = step("config-yaml");
    const expected = YML
      .replace("  veille.tri: claude/sonnet            #", "  watch.triage: claude/sonnet            #")
      .replace('  "veille.recherche": websearch', '  "watch.search": websearch')
      .replace('          "famille": pocket_tts\n          voix: clone ', '          "family": pocket_tts\n          voice: clone ')
      .replace("          famille: qwen3_tts\n          voix: 'integree'\n          speaker: ono_anna\n          langue: fr", "          family: qwen3_tts\n          voice: 'builtin'\n          speaker: ono_anna\n          language: fr")
      .replace("notifications: importantes } }   # Orca", "notifications: important } }   # Orca")
      .replace("      seuil: 7\n      lot: 10\n      maxVersModele: 40\n      fenetreJours: 3\n      interets:\n        ia-locale:\n          nom: IA locale     # mon sujet",
        "      threshold: 7\n      batch: 10\n      maxToModel: 40\n      windowDays: 3\n      interests:\n        ia-locale:\n          name: IA locale     # mon sujet")
      .replace("          flux:\n            - https://a.example", "          feeds:\n            - https://a.example").replace("          requetes: [llama.cpp]", "          queries: [llama.cpp]")
      .replace("{ delaiDemarrageS: 30 }", "{ startupDelay_s: 30 }").replace('      langue: "fr"', '      language: "fr"').replace("      dossier: ~/Travaux", "      folder: ~/Travaux");
    expect(read("floppy.yml")).toBe(expected);
    // Seuls les endroits visés ont changé : toutes les autres lignes sont identiques, dans le même ordre.
    const a = YML.split("\n"); const b = expected.split("\n");
    expect(b).toHaveLength(a.length);
    expect(b.filter((l, i) => l !== a[i])).toHaveLength(19);
    // Le fichier relu par le chargeur de la config est valide, et les plugins inconnus n'ont pas bougé.
    expect(read("floppy.yml")).toContain("      famille: x    # pas à moi\n      nom: y\n      interets: [a]\n");
    expect(read("floppy.yml")).toContain("plugin: orca-autre, config: { notifications: importantes, famille: x }");
    expect(read("floppy.yml.bak-config-yaml")).toBe(YML);
    // Rapport : des chemins avec « * » à la place des identifiants choisis par l'utilisateur, jamais de valeurs.
    const keys = r.changes[0]!.keys;
    expect(keys).toContain("slots.veille.tri");
    expect(keys).toContain("plugins[plugin=tts-audiocpp].config.models.*.famille");
    expect(keys).toContain("plugins[plugin=veille].config.interets.*.nom");
    expect(keys).toContain("plugins[plugin=orca].config.notifications");
    expect(JSON.stringify(r)).not.toMatch(/ia-locale|Travaux|femme|Floppy/);
  });

  it("l'ancre est retouchée une fois, à sa définition ; la copie qui la reprend suit", () => {
    write("floppy.yml", YML);
    step("config-yaml");
    expect(read("floppy.yml").match(/family"?:/g)).toHaveLength(2);
    expect(read("floppy.yml")).toContain("        copie: *base");
  });

  it("fins de ligne CRLF et fichier sans retour final : gardés", () => {
    const crlf = YML.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
    write("floppy.yml", crlf);
    step("config-yaml");
    const out = read("floppy.yml");
    expect(out).toBe(crlf.replace("veille.tri", "watch.triage").replace('"veille.recherche"', '"watch.search"').replace('"famille"', '"family"').replace(/\bfamille: qwen3_tts/, "family: qwen3_tts")
      .replace(/ voix: clone/, " voice: clone").replace("voix: 'integree'", "voice: 'builtin'").replace("langue: fr", "language: fr").replace("notifications: importantes } }   #", "notifications: important } }   #")
      .replace("seuil", "threshold").replace("lot:", "batch:").replace("maxVersModele", "maxToModel").replace("fenetreJours", "windowDays").replace("interets:\r\n        ia-locale", "interests:\r\n        ia-locale")
      .replace("nom: IA locale", "name: IA locale").replace("flux:\r\n            - https", "feeds:\r\n            - https").replace("requetes:", "queries:").replace("delaiDemarrageS", "startupDelay_s")
      .replace('langue: "fr"', 'language: "fr"').replace("dossier:", "folder:"));
    expect(out.includes("\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("idempotente : le fichier déjà converti n'est ni réécrit ni sauvegardé ; sans floppy.yml : rien", () => {
    write("floppy.yml", YML);
    step("config-yaml");
    const once = read("floppy.yml");
    rmSync(join(home, "floppy.yml.bak-config-yaml"));
    expect(step("config-yaml", { force: true }).changes).toEqual([]);
    expect(read("floppy.yml")).toBe(once);
    expect(existsSync(join(home, "floppy.yml.bak-config-yaml"))).toBe(false);
    rmSync(join(home, "floppy.yml")); rmSync(join(home, "migrations.json"));
    expect(step("config-yaml")).toMatchObject({ changes: [], skipped: [] });
  });

  it("ancien et nouveau nom dans la même table : rien n'est écrasé, le conflit est rapporté", () => {
    const text = "plugins:\n  - id: sx\n    plugin: searxng\n    config:\n      langue: fr\n      language: en\n";
    write("floppy.yml", text);
    const r = step("config-yaml");
    expect(read("floppy.yml")).toBe(text);
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([{ file: "floppy.yml", key: "plugins[plugin=searxng].config.langue" }]);
  });

  it("YAML illisible : laissé tel quel, signalé ; autres fichiers non concernés", () => {
    const text = "plugins:\n  - id: [oups\n";
    write("floppy.yml", text);
    expect(step("config-yaml").skipped).toEqual([{ file: "floppy.yml", why: "unreadable" }]);
    expect(read("floppy.yml")).toBe(text);
  });

  it("un fichier sans rien à changer (config d'exemple actuelle) est laissé intact", () => {
    const text = "# rien\nslots:\n  watch.triage: claude/sonnet\nplugins:\n  - { id: orca, plugin: orca, config: { notifications: important } }\n  - id: veille\n    plugin: veille\n    config:\n      interests:\n        a:\n          name: A\n          feeds: []\n";
    write("floppy.yml", text);
    expect(step("config-yaml").changes).toEqual([]);
    expect(read("floppy.yml")).toBe(text);
  });
});

describe("étape items-fields", () => {
  it("voix locales : champs `famille`, `familleAutre`, `voix`, `langue` et valeurs `integree`, `autre` (ajoutées et modifiées)", () => {
    write("floppy.yml", "plugins:\n  - id: tts-local\n    plugin: tts-audiocpp\n");
    const OLD = {
      added: {
        anna: { kind: "voice", values: { label: "Anna", model: "m.gguf", famille: "qwen3_tts", familleAutre: "", voix: "integree", speaker: "ono_anna", langue: "fr", rate: 0, mode: "streaming" } },
        etrange: { kind: "gguf", values: { label: "E", famille: "autre", familleAutre: "kokoro_tts", voix: "clone", refWav: "r.wav" } },
      },
      edits: { femme: { voix: "clone", langue: "en" } },
      disabled: ["anna"], removed: [], children: {}, extra: { last: "anna" },
    };
    put("items/tts-local.json", OLD);
    const r = step("items-fields");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.file).toBe("items/tts-local.json");
    expect(json("items/tts-local.json")).toEqual({
      added: {
        anna: { kind: "voice", values: { label: "Anna", model: "m.gguf", family: "qwen3_tts", familyOther: "", voice: "builtin", speaker: "ono_anna", language: "fr", rate: 0, mode: "streaming" } },
        etrange: { kind: "gguf", values: { label: "E", family: "other", familyOther: "kokoro_tts", voice: "clone", refWav: "r.wav" } },
      },
      edits: { femme: { voice: "clone", language: "en" } },
      disabled: ["anna"], removed: [], children: {}, extra: { last: "anna" },
    });
    expect(json("items/tts-local.json.bak-items-fields")).toEqual(OLD);
    expect(JSON.stringify(r)).not.toMatch(/Anna|kokoro/);
  });

  it("veille : type `interet` → `interest` et champs `nom`, `flux`, `requetes` (ajoutés et modifiés)", () => {
    write("floppy.yml", "plugins:\n  - id: veille\n    plugin: veille\n");
    put("items/veille.json", {
      added: { bretagne: { kind: "interet", values: { nom: "Bretagne", description: "d", flux: ["https://x/rss"], requetes: ["festival"], max: 8 } } },
      edits: { "ia-locale": { nom: "IA", description: "d2", flux: [], requetes: ["gguf"], max: 3 } },
      disabled: [], removed: [], children: { bretagne: { "f:https://x/rss": false } }, extra: {},
    });
    step("items-fields");
    expect(json("items/veille.json")).toEqual({
      added: { bretagne: { kind: "interest", values: { name: "Bretagne", description: "d", feeds: ["https://x/rss"], queries: ["festival"], max: 8 } } },
      edits: { "ia-locale": { name: "IA", description: "d2", feeds: [], queries: ["gguf"], max: 3 } },
      disabled: [], removed: [], children: { bretagne: { "f:https://x/rss": false } }, extra: {},
    });
  });

  it("boîtes mail : fournisseur, adresse, motdepasse, destinataire, serveur, securite ; valeur `autre`", () => {
    write("floppy.yml", "plugins:\n  - id: mail\n    plugin: notify-mail\n");
    put("items/mail.json", {
      added: { perso: { kind: "smtp", values: { label: "Perso", fournisseur: "autre", adresse: "moi@x.fr", destinataire: "toi@x.fr", serveur: "smtp.x.fr", port: 587, securite: "starttls", motdepasse: "s" } } },
      edits: {}, disabled: [], removed: [], children: {}, extra: {},
    });
    step("items-fields");
    expect(json("items/mail.json").added.perso).toEqual({ kind: "smtp", values: { label: "Perso", provider: "other", address: "moi@x.fr", recipient: "toi@x.fr", server: "smtp.x.fr", port: 587, security: "starttls", password: "s" } });
  });

  it("plugins ajoutés et leurs modifications (items/apps.json) : la configuration suit les règles de son plugin ; l'entrée d'une modification se lit dans floppy.yml", () => {
    write("floppy.yml", "plugins:\n  - id: web\n    plugin: searxng\n  - id: veille\n    plugin: veille\n  - id: inconnu\n    plugin: contoso\n");
    put("items/apps.json", {
      added: {
        sx2: { kind: "searxng", values: { url: "http://localhost:8888", langue: "fr" } },
        ses: { kind: "agent-sessions", values: { dossier: "~/Travaux" } },
        etranger: { kind: "contoso", values: { langue: "fr" } },
      },
      edits: { web: { langue: "en" }, veille: { seuil: 8 }, inconnu: { langue: "fr" } },
      disabled: [], removed: [], children: { m365: { m365_add_meeting: false } }, extra: { tools: { veille: [{ name: "watch_feedback", description: "d", level: "write" }] } },
    });
    const r = step("items-fields");
    expect(r.changes[0]!.keys.sort()).toEqual(["added.values.dossier", "added.values.langue", "edits.langue", "edits.seuil"]);
    const d = json("items/apps.json");
    expect(d.added.sx2.values).toEqual({ url: "http://localhost:8888", language: "fr" });
    expect(d.added.ses.values).toEqual({ folder: "~/Travaux" });
    expect(d.added.etranger.values).toEqual({ langue: "fr" });
    expect(d.edits).toEqual({ web: { language: "en" }, veille: { threshold: 8 }, inconnu: { langue: "fr" } });
    // Les noms d'outils ne sont pas de cette étape (voir tools-items-apps).
    expect(d.children).toEqual({ m365: { m365_add_meeting: false } });
    expect(d.extra.tools.veille[0].name).toBe("watch_feedback");
  });

  it("les deux champs présents : le nouveau est gardé et le conflit rapporté ; fichiers d'autres plugins et déjà convertis : intacts", () => {
    write("floppy.yml", "plugins:\n  - id: veille\n    plugin: veille\n  - id: autre\n    plugin: contoso\n");
    put("items/veille.json", { added: { a: { kind: "interest", values: { nom: "vieux", name: "neuf" } } }, edits: {}, disabled: [], removed: [], children: {}, extra: {} });
    put("items/autre.json", { added: { a: { kind: "interet", values: { nom: "x" } } }, edits: {}, disabled: [], removed: [], children: {}, extra: {} });
    const r = step("items-fields");
    expect(json("items/veille.json").added.a.values).toEqual({ name: "neuf" });
    expect(r.conflicts).toEqual([{ file: "items/veille.json", key: "added.values.nom" }]);
    expect(json("items/autre.json").added.a).toEqual({ kind: "interet", values: { nom: "x" } });
    rmSync(join(home, "migrations.json"));
    expect(step("items-fields").changes).toEqual([]);
  });

  it("fichier d'éléments abîmé : laissé tel quel ; sans dossier items : rien", () => {
    write("floppy.yml", "plugins:\n  - id: veille\n    plugin: veille\n");
    mkdirSync(join(home, "items"));
    write("items/veille.json", "{ pas du json");
    expect(step("items-fields").skipped).toEqual([{ file: "items/veille.json", why: "unreadable" }]);
    rmSync(join(home, "items"), { recursive: true });
    rmSync(join(home, "migrations.json"));
    expect(step("items-fields")).toMatchObject({ changes: [], skipped: [] });
  });
});

describe("étape inbox-trust", () => {
  it("la confiance `non` devient `denied`, les autres valeurs et champs restent", () => {
    const OLD = { apps: { differendum: { name: "Differendum", schemes: ["inwink-differendum"], seen: "2026-11-01", trust: "non", asked: true }, b: { name: "B", schemes: [], seen: "x", trust: "app" }, c: { name: "C", schemes: [], seen: "x" } } };
    put("inbox-apps.json", OLD);
    const r = step("inbox-trust");
    expect(r.changes).toEqual([{ file: "inbox-apps.json", keys: ["apps.trust"] }]);
    expect(json("inbox-apps.json")).toEqual({ apps: { ...OLD.apps, differendum: { ...OLD.apps.differendum, trust: "denied" } } });
    expect(json("inbox-apps.json.bak-inbox-trust")).toEqual(OLD);
    rmSync(join(home, "migrations.json"));
    expect(step("inbox-trust").changes).toEqual([]);
  });
});

describe("étape watch-preferences", () => {
  it("global et par centre d'intérêt : aime, evite, bannis, exemples (titre, avis), interets", () => {
    const OLD = {
      global: { aime: ["llama.cpp"], evite: ["crypto"], bannis: ["bitcoin"], exemples: [{ titre: "Un article", avis: "+", date: "2026-11-06T08:00:00.000Z" }] },
      interets: { "ia-locale": { aime: ["gguf"], evite: [], bannis: [], exemples: [{ titre: "Autre", avis: "-", date: "d" }] } },
    };
    put("veille/preferences.json", OLD);
    const r = step("watch-preferences");
    expect(r.changes).toHaveLength(1);
    expect(json("veille/preferences.json")).toEqual({
      global: { likes: ["llama.cpp"], avoids: ["crypto"], banned: ["bitcoin"], examples: [{ title: "Un article", feedback: "+", date: "2026-11-06T08:00:00.000Z" }] },
      interests: { "ia-locale": { likes: ["gguf"], avoids: [], banned: [], examples: [{ title: "Autre", feedback: "-", date: "d" }] } },
    });
    expect(json("veille/preferences.json.bak-watch-preferences")).toEqual(OLD);
    expect(JSON.stringify(r)).not.toMatch(/llama|Un article|ia-locale/);
    rmSync(join(home, "migrations.json"));
    expect(step("watch-preferences").changes).toEqual([]);
  });

  it("fichier absent : rien", () => {
    expect(step("watch-preferences")).toMatchObject({ changes: [], skipped: [] });
  });
});

describe("toutes les étapes ensemble", () => {
  it("un dossier d'avant ces étapes : tout est converti en un passage, un second passage ne change plus rien", () => {
    put("settings.json", { ton: "x", orca_notifications: "aucune", cerveau: "a", "taches.veille.quotidienne": "jamais" });
    write("floppy.yml", YML);
    put("inbox-apps.json", { apps: { a: { name: "A", schemes: [], seen: "x", trust: "non" } } });
    const first = migrateHome(home);
    expect(first.filter((r) => r.changes.length).map((r) => r.step).sort()).toEqual(["config-yaml", "inbox-trust", "plugin-ids", "settings-keys", "settings-values"]);
    expect(first.every((r) => !r.error)).toBe(true);
    expect(json("settings.json")).toEqual({ tone: "x", orca_notifications: "none", "tasks.watch.daily": "never" });
    expect(migrateHome(home).every((r) => r.alreadyApplied)).toBe(true);
    const forced = migrateHome(home, { force: true });
    expect(forced.flatMap((r) => r.changes)).toEqual([]);
  });

  it("les étapes déjà notées du lot 1 ne sont pas rejouées ; les nouvelles ont des versions croissantes et des noms uniques", () => {
    expect(HOME_MIGRATIONS.map((s) => s.version)).toEqual([1, 2, 3, 10, 11, 12, 13, 14, 15, 20, 21, 22, 30, 31, 32, 33, 34, 35, 36, 37]);
    expect(new Set(HOME_MIGRATIONS.map((s) => s.id)).size).toBe(HOME_MIGRATIONS.length);
    writeFileSync(join(home, "migrations.json"), JSON.stringify({ version: 2, applied: { "documents-title": "x", "onboarding-level": "x" } }));
    put("settings.json", { ton: "x" });
    const r = migrateHome(home);
    expect(r.slice(0, 2).every((x) => x.alreadyApplied)).toBe(true);
    expect(r.slice(2).some((x) => x.changes.length)).toBe(true);
    expect(readMigrationMarker(home).version).toBe(37);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Étapes 20 à 22 : les noms d'outils de Floppy (configuration, éléments, commandes).
// ---------------------------------------------------------------------------------------------------------------

describe("étape tools-config-yaml", () => {
  const OLD = [
    "# mes accords",
    "approvals:",
    "  write: ask",
    "  toolRules:",
    "    - { source: vocabulary, tool: corriger_vocabulaire, level: write, rule: always }",
    "    - { source: m365, tool: m365_ajouter_rdv, level: write, rule: always }",
    "    - { source: work, tool: ouvrir_url, level: write, rule: always }   # outil d'un serveur extérieur",
    "    - { source: tools, tool: m365_ajouter_rdv, level: write, rule: ask }",
    "    - { source: core, tool: changer_reglage, level: write, rule: ask }",
    "plugins:",
    "  - { id: vocabulary, plugin: vocabulary }",
    "  - { id: m365, plugin: m365 }",
    "  - { id: work, plugin: contoso }",
    "  - { id: tools, plugin: tools, config: { servers: { work: { include: [ouvrir_url, agenda_du_jour], levels: { ouvrir_url: write } } } } }",
    "  - { id: brain, plugin: brain-aisdk, config: { delegateTool: deleguer } }",
    "",
  ].join("\n");

  it("renomme les outils de Floppy selon le plugin de la source, jamais ceux d'un serveur extérieur ni leurs listes include / levels", () => {
    write("floppy.yml", OLD);
    const r = step("tools-config-yaml");
    expect(r.error).toBeUndefined();
    const text = read("floppy.yml");
    expect(text).toContain("source: vocabulary, tool: correct_vocabulary");
    expect(text).toContain("source: m365, tool: m365_add_meeting");
    expect(text).toContain("source: core, tool: change_setting");
    expect(text).toContain("delegateTool: delegate");
    // Un autre plugin ayant le même nom d'outil, un serveur extérieur et ses listes : intacts.
    expect(text).toContain("source: work, tool: ouvrir_url, level: write, rule: always }   # outil d'un serveur extérieur");
    expect(text).toContain("source: tools, tool: m365_ajouter_rdv");
    expect(text).toContain("include: [ouvrir_url, agenda_du_jour], levels: { ouvrir_url: write }");
    // Le reste (commentaire, mise en forme) est gardé octet pour octet : seuls les noms changent.
    expect(text.replace("correct_vocabulary", "corriger_vocabulaire").replace("m365_add_meeting", "m365_ajouter_rdv").replace("change_setting", "changer_reglage").replace("delegateTool: delegate", "delegateTool: deleguer")).toBe(OLD);
    expect(read("floppy.yml.bak-tools-config-yaml")).toBe(OLD);
    expect(r.changes[0]!.keys.sort()).toEqual(["approvals.toolRules[source=core].tool", "approvals.toolRules[source=m365].tool", "approvals.toolRules[source=vocabulary].tool", "plugins[plugin=brain-aisdk].config.delegateTool"]);
  });

  it("deuxième passage et rejeu forcé : sans effet ; fichier absent ou illisible : intact", () => {
    write("floppy.yml", OLD);
    step("tools-config-yaml");
    expect(step("tools-config-yaml").alreadyApplied).toBe(true);
    expect(step("tools-config-yaml", { force: true }).changes).toEqual([]);
    rmSync(join(home, "migrations.json"));
    rmSync(join(home, "floppy.yml"));
    expect(step("tools-config-yaml").changes).toEqual([]);
    write("floppy.yml", "plugins: [ {\n");
    rmSync(join(home, "migrations.json"));
    expect(step("tools-config-yaml").changes).toEqual([]);
    expect(read("floppy.yml")).toBe("plugins: [ {\n");
  });
});

describe("étape tools-items-apps", () => {
  it("renomme les outils des applications de Floppy (children, extra.tools) et pas ceux d'un autre plugin ni de tools.json", () => {
    write("floppy.yml", "plugins:\n  - { id: m365, plugin: m365 }\n  - { id: browser, plugin: browser }\n  - { id: tools, plugin: tools }\n  - { id: autre, plugin: contoso }\n");
    put("items/apps.json", {
      added: {}, edits: {}, disabled: [], removed: [],
      children: { m365: { m365_ajouter_rdv: false, m365_presence: true }, browser: { ouvrir_url: true }, autre: { ouvrir_url: false } },
      extra: { tools: {
        browser: [{ name: "ouvrir_url", description: "d", level: "write" }],
        m365: [{ name: "m365_mails_non_lus", description: "d", level: "read" }, { name: "m365_presence", description: "d", level: "read" }],
        autre: [{ name: "ouvrir_url", description: "d", level: "write" }],
      } },
    });
    const before = read("items/apps.json");
    put("items/tools.json", { added: {}, edits: {}, disabled: ["work"], removed: [], children: { work: { ouvrir_url: true } }, extra: { tools: { work: [{ name: "ouvrir_url" }, { name: "agenda_du_jour" }] } } });
    const tools = read("items/tools.json");
    const r = step("tools-items-apps");
    expect(r.error).toBeUndefined();
    const d = json("items/apps.json");
    expect(d.children).toEqual({ m365: { m365_presence: true, m365_add_meeting: false }, browser: { open_url: true }, autre: { ouvrir_url: false } });
    expect(d.extra.tools.browser[0].name).toBe("open_url");
    expect(d.extra.tools.m365.map((t: { name: string }) => t.name)).toEqual(["m365_unread_mail", "m365_presence"]);
    expect(d.extra.tools.autre[0].name).toBe("ouvrir_url");
    expect(read("items/apps.json.bak-tools-items-apps")).toBe(before);
    // Les outils d'un serveur extérieur ne sont jamais lus.
    expect(read("items/tools.json")).toBe(tools);
    expect(existsSync(join(home, "items/tools.json.bak-tools-items-apps"))).toBe(false);
    expect(step("tools-items-apps", { force: true }).changes).toEqual([]);
  });

  it("entrée absente de floppy.yml : son id sert de type ; l'ancien et le nouveau nom présents : le nouveau est gardé, conflit rapporté", () => {
    put("items/apps.json", { added: {}, edits: {}, disabled: [], removed: [], children: { orca: { orca_ecran: false, orca_screen: true, orca_agents: true } }, extra: {} });
    const r = step("tools-items-apps");
    expect(json("items/apps.json").children.orca).toEqual({ orca_screen: true, orca_agents: true });
    expect(r.conflicts).toEqual([{ file: "items/apps.json", key: "children.*.orca_ecran" }]);
  });
});

describe("étape tools-command-placeholder", () => {
  it("{texte} devient {text} dans les commandes du plugin tools seulement", () => {
    write("floppy.yml", "plugins:\n  - { id: tools, plugin: tools }\n  - { id: autre, plugin: contoso }\n");
    put("items/tools.json", { added: {
      echo: { kind: "command", values: { label: "Écho", command: "echo", args: ["-n", "{texte}", "fin"] } },
      srv: { kind: "mcp-local", values: { command: "npx", args: ["{texte}"] } },
    }, edits: {}, disabled: [], removed: [], children: {}, extra: {} });
    put("items/autre.json", { added: { x: { kind: "command", values: { args: ["{texte}"] } } }, edits: {}, disabled: [], removed: [], children: {}, extra: {} });
    const r = step("tools-command-placeholder");
    expect(r.changes).toEqual([{ file: "items/tools.json", keys: ["added.values.args"] }]);
    const d = json("items/tools.json");
    expect(d.added.echo.values.args).toEqual(["-n", "{text}", "fin"]);
    expect(d.added.srv.values.args).toEqual(["{texte}"]);
    expect(json("items/autre.json").added.x.values.args).toEqual(["{texte}"]);
    expect(step("tools-command-placeholder", { force: true }).changes).toEqual([]);
  });
});

describe("numérotation des étapes d'outils", () => {
  it("les outils commencent à 20, après les étapes 10 à 15 (les rangs 4 à 9 et 16 à 19 restent libres)", () => {
    expect(HOME_MIGRATIONS.filter((s) => s.version >= 16).map((s) => [s.id, s.version])).toEqual([["tools-config-yaml", 20], ["tools-items-apps", 21], ["tools-command-placeholder", 22],
      ["plugin-ids", 30], ["watch-folder", 31], ["watch-database", 32], ["documents-tags", 33], ["folders", 34], ["connectors-settings", 35], ["wakeword-words", 36], ["orca-surveillance", 37]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Étapes 30 à 37 : identifiants de plugins, dossiers et fichiers, base de la veille, anciens réglages.
// ---------------------------------------------------------------------------------------------------------------

const has = (rel: string) => existsSync(join(home, rel));

/** Un floppy.yml tel que les étapes précédentes le laissent : commentaires, entrées par défaut ET entrée choisie par l'utilisateur pour le même plugin. */
const YML_30 = [
  "# mes notes",
  "approvals:",
  "  write: ask",
  "  toolRules:",
  "    - { source: veille, tool: watch_feedback, level: write, rule: always }   # mon accord",
  "    - { source: autre, tool: x, level: write, rule: ask }",
  "plugins:",
  "  - { id: bodyel, plugin: body-electron, config: { avatar: goutte } }   # mon avatar",
  "  - { id: avatar-essaim, plugin: avatar-essaim }",
  "  - { id: avatar-goutte, plugin: avatar-goutte }   # celui-là me plaît",
  "  - { id: avatar-oscillo, plugin: avatar-oscillo }",
  "  - { id: avatar-tv, plugin: avatar-tv }",
  "  - id: veille",
  "    plugin: veille",
  "    config:",
  "      interests:",
  "        ia-locale: { name: IA locale }",
  "  - id: veille-travail   # ma deuxième veille",
  "    plugin: veille",
  "  - { id: orca, plugin: orca }",
  "",
].join("\n");

const YML_30_NEW = YML_30
  .replace("source: veille,", "source: watch,")
  .replace("avatar: goutte", "avatar: droplet")
  .replace("id: avatar-essaim, plugin: avatar-essaim", "id: avatar-swarm, plugin: avatar-swarm")
  .replace("id: avatar-goutte, plugin: avatar-goutte", "id: avatar-droplet, plugin: avatar-droplet")
  .replace("id: avatar-oscillo, plugin: avatar-oscillo", "id: avatar-neon-scope, plugin: avatar-neon-scope")
  .replace("  - id: veille\n    plugin: veille\n", "  - id: watch\n    plugin: watch\n")
  .replace("id: veille-travail   # ma deuxième veille\n    plugin: veille", "id: veille-travail   # ma deuxième veille\n    plugin: watch");

/** Les données d'un dossier de travail avec les entrées par défaut de la veille et des avatars. */
function seed30(): void {
  write("floppy.yml", YML_30);
  put("settings.json", {
    tone: "x", "tasks.veille.quotidienne": "07:30 mon-fri", "tasks.veille.quotidienne.send": "Telegram",
    "tasks.veille-travail.quotidienne": "never", "tasks.scheduler.autre": "every 3h",
  });
  put("tasks.json", {
    "veille/quotidienne": { lastRun: "2026-11-09T07:30:00.000Z", last: { at: "2026-11-09T07:31:00.000Z", ok: true, text: "Ta veille est prête." } },
    "veille-travail/quotidienne": { lastRun: "2026-11-08T07:30:00.000Z" },
    "scheduler/autre": { lastRun: "2026-11-07T07:30:00.000Z" },
  });
  put("items/veille.json", { added: { x: { kind: "interest", values: { name: "X" } } }, edits: { "ia-locale": { threshold: 7 } }, disabled: [], removed: [], children: { "ia-locale": { "f:https://a.test": false } }, extra: {} });
  put("items/veille-travail.json", { added: {}, edits: {}, disabled: ["a"], removed: [], children: {}, extra: {} });
  put("items/apps.json", {
    added: { veille: { kind: "veille", values: {} }, perso: { kind: "avatar-goutte", values: {} }, mien: { kind: "body-electron", values: { avatar: "oscillo" } } },
    edits: { bodyel: { avatar: "essaim", port: 1 }, veille: { threshold: 8 }, "veille-travail": { threshold: 9 } },
    disabled: ["avatar-essaim", "veille", "autre"], removed: ["avatar-goutte"], children: { veille: { watch_feedback: false } },
    extra: { tools: { veille: [{ name: "watch_feedback", description: "d", level: "write" }], autre: [] } },
  });
  put("items/avatars.json", { added: {}, edits: {}, disabled: ["essaim", "oscillo", "tv"], removed: [], children: {}, extra: { current: "goutte" } });
}

describe("étape plugin-ids", () => {
  it("la veille et les avatars : entrées par défaut renommées avec tout ce qui en dérive, entrée choisie par l'utilisateur gardée, commentaires gardés", () => {
    seed30();
    const r = step("plugin-ids");
    expect(r.error).toBeUndefined();
    expect(read("floppy.yml")).toBe(YML_30_NEW);
    expect(json("settings.json")).toEqual({
      tone: "x", "tasks.watch.daily": "07:30 mon-fri", "tasks.watch.daily.send": "Telegram", "tasks.veille-travail.daily": "never", "tasks.scheduler.autre": "every 3h",
    });
    expect(json("tasks.json")).toEqual({
      "watch/daily": { lastRun: "2026-11-09T07:30:00.000Z", last: { at: "2026-11-09T07:31:00.000Z", ok: true, text: "Ta veille est prête." } },
      "veille-travail/daily": { lastRun: "2026-11-08T07:30:00.000Z" },
      "scheduler/autre": { lastRun: "2026-11-07T07:30:00.000Z" },
    });
    // Le fichier d'éléments de l'entrée par défaut change de nom (copie, original gardé) ; celui de l'entrée de l'utilisateur ne bouge pas.
    expect(has("items/veille.json")).toBe(false);
    expect(json("items/watch.json").edits).toEqual({ "ia-locale": { threshold: 7 } });
    expect(json("items/veille.json.bak-plugin-ids").edits).toEqual({ "ia-locale": { threshold: 7 } });
    expect(json("items/veille-travail.json").disabled).toEqual(["a"]);
    const apps = json("items/apps.json");
    expect(apps.added).toEqual({ watch: { kind: "watch", values: {} }, perso: { kind: "avatar-droplet", values: {} }, mien: { kind: "body-electron", values: { avatar: "neon-scope" } } });
    expect(apps.edits).toEqual({ bodyel: { avatar: "swarm", port: 1 }, watch: { threshold: 8 }, "veille-travail": { threshold: 9 } });
    expect(apps.disabled).toEqual(["avatar-swarm", "watch", "autre"]);
    expect(apps.removed).toEqual(["avatar-droplet"]);
    expect(apps.children).toEqual({ watch: { watch_feedback: false } });
    expect(Object.keys(apps.extra.tools)).toEqual(["watch", "autre"]);
    expect(json("items/avatars.json")).toMatchObject({ disabled: ["swarm", "neon-scope", "tv"], extra: { current: "droplet" } });
    // Sauvegardes à côté de chaque fichier changé.
    for (const f of ["floppy.yml", "settings.json", "tasks.json", "items/apps.json", "items/avatars.json"]) expect(has(`${f}.bak-plugin-ids`)).toBe(true);
    expect(read("floppy.yml.bak-plugin-ids")).toBe(YML_30);
  });

  it("à blanc : des noms seulement (jamais de valeurs), rien n'est écrit", () => {
    seed30();
    const r = step("plugin-ids", { dryRun: true });
    expect(r.changes.map((c) => c.file)).toEqual(["tasks.json", "settings.json", "items/veille.json", "items/apps.json", "items/avatars.json", "floppy.yml"]);
    expect(r.changes[2]).toEqual({ file: "items/veille.json", keys: [], renamedTo: "items/watch.json" });
    expect(JSON.stringify(r)).not.toMatch(/Telegram|07:30|Ta veille/);
    expect(read("floppy.yml")).toBe(YML_30);
    expect(has("items/watch.json")).toBe(false);
    expect(has("migrations.json")).toBe(false);
  });

  it("second passage (marqueur), rejeu forcé et dossier déjà au nouveau format : sans effet", () => {
    seed30();
    const first = runHomeMigrations(home, HOME_MIGRATIONS.filter((s) => s.id === "plugin-ids"));
    expect(first[0]!.changes.length).toBeGreaterThan(0);
    const after = read("floppy.yml");
    expect(step("plugin-ids").alreadyApplied).toBe(true);
    const forced = step("plugin-ids", { force: true });
    expect(forced.changes).toEqual([]);
    expect(forced.skipped).toEqual([]);
    expect(read("floppy.yml")).toBe(after);
    // Un dossier créé directement au nouveau format (installation neuve).
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    write("floppy.yml", YML_30_NEW);
    put("tasks.json", { "watch/daily": { lastRun: "x" } });
    put("settings.json", { "tasks.watch.daily": "never" });
    const fresh = step("plugin-ids");
    expect(fresh.changes).toEqual([]);
    expect(read("floppy.yml")).toBe(YML_30_NEW);
  });

  it("le nouvel id est déjà pris par une autre entrée : l'entrée garde son id (conflit signalé), le type du plugin et la tâche changent quand même", () => {
    write("floppy.yml", "plugins:\n  - { id: watch, plugin: contoso }\n  - { id: veille, plugin: veille }\n");
    put("settings.json", { "tasks.veille.quotidienne": "never" });
    put("tasks.json", { "veille/quotidienne": { lastRun: "x" } });
    put("items/veille.json", { added: {}, edits: {}, disabled: [], removed: [], children: {}, extra: {} });
    const r = step("plugin-ids");
    expect(r.conflicts).toEqual([{ file: "floppy.yml", key: "plugins[veille].id", kept: "both" }]);
    expect(read("floppy.yml")).toBe("plugins:\n  - { id: watch, plugin: contoso }\n  - { id: veille, plugin: watch }\n");
    expect(json("settings.json")).toEqual({ "tasks.veille.daily": "never" });
    expect(json("tasks.json")).toEqual({ "veille/daily": { lastRun: "x" } });
    expect(has("items/veille.json")).toBe(true);
    expect(has("items/watch.json")).toBe(false);
  });

  it("le fichier d'éléments de la nouvelle entrée existe déjà : conflit, les deux fichiers sont laissés", () => {
    write("floppy.yml", "plugins:\n  - { id: veille, plugin: veille }\n");
    put("items/veille.json", { added: {}, edits: { a: { x: 1 } }, disabled: [], removed: [], children: {}, extra: {} });
    put("items/watch.json", { added: {}, edits: { b: { y: 2 } }, disabled: [], removed: [], children: {}, extra: {} });
    const r = step("plugin-ids");
    expect(r.skipped).toEqual([{ file: "items/veille.json", why: "exists" }]);
    expect(json("items/veille.json").edits).toEqual({ a: { x: 1 } });
    expect(json("items/watch.json").edits).toEqual({ b: { y: 2 } });
    expect(read("floppy.yml")).toBe("plugins:\n  - { id: watch, plugin: watch }\n");
  });

  it("floppy.yml illisible : signalé, laissé tel quel ; le choix d'avatar des éléments suit quand même", () => {
    write("floppy.yml", "plugins: [ {");
    put("items/avatars.json", { added: {}, edits: {}, disabled: [], removed: [], children: {}, extra: { current: "oscillo" } });
    const r = step("plugin-ids");
    expect(r.skipped).toEqual([{ file: "floppy.yml", why: "unreadable" }]);
    expect(read("floppy.yml")).toBe("plugins: [ {");
    expect(json("items/avatars.json").extra.current).toBe("neon-scope");
  });
});

// ---- Dossier et base de la veille ----

/** Une base de la veille à l'ancien format (noms français), avec des lignes. */
function oldWatchDb(rel: string): void {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  const db = new DatabaseSync(join(home, rel));
  db.exec(`
    CREATE TABLE vus (url TEXT PRIMARY KEY, titre TEXT, interet TEXT, vu_le TEXT);
    CREATE TABLE digest (numero INTEGER PRIMARY KEY, doc TEXT, interet TEXT, titre TEXT, url TEXT, source TEXT, resume TEXT);
    INSERT INTO vus VALUES ('https://blog.ai/1', 'Gemma 5', 'ia-locale', '${new Date().toISOString()}'), ('https://blog.ai/2', 'Kokoro', 'ia-locale', '${new Date().toISOString()}');
    INSERT INTO digest VALUES (1, 'doc1', 'ia-locale', 'Gemma 5 sort', 'https://blog.ai/1', 'Blog IA', 'Un nouveau modèle'), (2, 'doc1', 'ia-locale', 'Kokoro', 'https://blog.ai/2', 'Blog IA', 'Une voix');
  `);
  db.close();
}

describe("étapes watch-folder et watch-database", () => {
  const folder = () => step("watch-folder");
  const database = () => step("watch-database");

  it("dossier et base déplacés, puis la base lue par le code réel du plugin (lignes gardées, ancien format gardé en copie)", () => {
    put("veille/preferences.json", { likes: ["llama.cpp"] });
    oldWatchDb("veille/veille.db");
    const f = folder();
    expect(f.changes).toEqual([{ file: "veille/veille.db", keys: [], renamedTo: "veille/watch.db" }, { file: "veille", keys: [], renamedTo: "watch" }]);
    expect(has("veille")).toBe(false);
    expect(json("watch/preferences.json")).toEqual({ likes: ["llama.cpp"] });
    expect(has("watch/veille.db.bak-watch-folder")).toBe(true);
    const d = database();
    expect(d.changes).toEqual([{ file: "watch/watch.db", keys: [
      "vus → seen", "seen.titre → title", "seen.interet → interest", "seen.vu_le → seen_at",
      "digest.numero → number", "digest.interet → interest", "digest.titre → title", "digest.resume → summary"] }]);
    const db = new WatchDb(join(home, "watch", "watch.db"));
    try {
      expect(db.seen("https://blog.ai/1")).toBe(true);
      expect(db.seen("https://blog.ai/9")).toBe(false);
      expect(db.digest()).toEqual([
        { number: 1, doc: "doc1", interest: "ia-locale", title: "Gemma 5 sort", url: "https://blog.ai/1", source: "Blog IA", summary: "Un nouveau modèle" },
        { number: 2, doc: "doc1", interest: "ia-locale", title: "Kokoro", url: "https://blog.ai/2", source: "Blog IA", summary: "Une voix" },
      ].map((x) => expect.objectContaining(x)));
      expect(db.article(2)?.summary).toBe("Une voix");
      // Le plugin écrit ensuite avec ses nouveaux noms dans la base migrée.
      db.markSeen([{ url: "https://blog.ai/3", title: "Trois", interest: "ia-locale" }]);
      expect(db.seen("https://blog.ai/3")).toBe(true);
    } finally { db.close(); }
    // La copie d'avant le changement garde l'ancien format.
    const bak = new DatabaseSync(join(home, "watch", "watch.db.bak-watch-database"), { readOnly: true });
    expect(bak.prepare("SELECT titre FROM vus ORDER BY url").all().map((x) => x.titre)).toEqual(["Gemma 5", "Kokoro"]);
    bak.close();
  });

  it("l'ordre des deux étapes ne compte pas : base d'abord ou dossier d'abord, même résultat", () => {
    oldWatchDb("veille/veille.db");
    expect(database().changes[0]!.file).toBe("veille/veille.db");
    expect(folder().changes.map((c) => c.renamedTo)).toEqual(["veille/watch.db", "watch"]);
    const db = new WatchDb(join(home, "watch", "watch.db"));
    expect(db.digest()).toHaveLength(2);
    db.close();
    expect(step("watch-database", { force: true }).changes).toEqual([]);
    expect(step("watch-folder", { force: true }).changes).toEqual([]);
  });

  it("à blanc : noms de fichiers, de tables et de colonnes ; rien n'est écrit", () => {
    oldWatchDb("veille/veille.db");
    const before = readFileSync(join(home, "veille", "veille.db"));
    const f = step("watch-folder", { dryRun: true });
    expect(f.changes.map((c) => c.renamedTo)).toEqual(["veille/watch.db", "watch"]);
    expect(step("watch-database", { dryRun: true }).changes[0]!.keys).toContain("vus → seen");
    expect(readFileSync(join(home, "veille", "veille.db")).equals(before)).toBe(true);
    expect(has("watch")).toBe(false);
    expect(has("migrations.json")).toBe(false);
  });

  it("le dossier watch/ existe déjà : conflit signalé, les deux dossiers gardés, la base de veille/ est quand même mise au nouveau format", () => {
    oldWatchDb("veille/veille.db");
    put("watch/preferences.json", { likes: ["autre"] });
    const f = folder();
    expect(f.skipped).toEqual([{ file: "veille", why: "exists" }]);
    expect(f.error).toBeUndefined();
    expect(has("veille/watch.db")).toBe(true);
    expect(json("watch/preferences.json")).toEqual({ likes: ["autre"] });
    expect(database().changes[0]!.file).toBe("veille/watch.db");
    const db = new WatchDb(join(home, "veille", "watch.db"));
    expect(db.digest()).toHaveLength(2);
    db.close();
  });

  it("base verrouillée : l'étape échoue et repart au prochain passage ; absente ou déjà au nouveau format : intacte", () => {
    expect(database().changes).toEqual([]);
    rmSync(join(home, "migrations.json"));
    oldWatchDb("watch/watch.db");
    const holder = new DatabaseSync(join(home, "watch", "watch.db"));
    holder.exec("BEGIN EXCLUSIVE");
    const locked = database();
    holder.exec("ROLLBACK");
    holder.close();
    expect(locked.error).toMatch(/watch\.db/);
    expect(has("migrations.json")).toBe(false);
    expect(database().error).toBeUndefined();
    // Déjà au nouveau format : rien.
    expect(step("watch-database", { force: true }).changes).toEqual([]);
  });
});

// ---- Documents ----

describe("étape documents-tags", () => {
  const DOC = (source: string, tags: string) => `---\ntitle: "Veille du jour"\ndate: 2026-11-06T08:00:00.000Z\nsource: ${source}\ntags: ${tags}\n---\n\nsource: "veille"\ntags: ["veille"]\n`;

  it("source et étiquettes de l'en-tête seulement (pas le corps), original sauvegardé", () => {
    write("documents/a.md", DOC('"veille"', '["veille"]'));
    write("documents/b.md", DOC('"floppy"', '["reponse", "x"]'));
    write("documents/c.md", DOC('"floppy"', '["watch"]'));
    const r = step("documents-tags");
    expect(r.changes).toEqual([{ file: "documents/a.md", keys: ["source", "tags"] }, { file: "documents/b.md", keys: ["tags"] }]);
    expect(read("documents/a.md")).toBe(DOC('"watch"', '["watch"]'));
    expect(read("documents/b.md")).toBe(DOC('"floppy"', '["answer","x"]'));
    expect(read("documents/c.md")).toBe(DOC('"floppy"', '["watch"]'));
    expect(read("documents/a.md.bak-documents-tags")).toBe(DOC('"veille"', '["veille"]'));
    expect(step("documents-tags", { force: true }).changes).toEqual([]);
  });

  it("les deux étiquettes présentes : sans doublon", () => {
    write("documents/a.md", DOC('"watch"', '["veille", "watch"]'));
    step("documents-tags");
    expect(read("documents/a.md")).toBe(DOC('"watch"', '["watch"]'));
  });
});

// ---- Dossiers et fichiers divers ----

describe("étape folders", () => {
  it("dossiers de travail du coder, essai de voix et copie du kit : renommés ; un second passage et un nouveau format : rien", () => {
    put("workspaces/coder/reglages/notes.json", { a: 1 });
    put("workspaces/coder/revues/b.json", { b: 2 });
    put("workspaces/brain-claude-cli/c.json", { c: 3 });
    mkdirSync(join(home, "tts-audiocpp"), { recursive: true });
    write("tts-audiocpp/essai.wav", "RIFF");
    put("plugins/exemple-minuteur/index.json", { d: 4 });
    const r = step("folders");
    expect(r.changes.map((c) => [c.file, c.renamedTo])).toEqual([
      ["workspaces/coder/reglages", "workspaces/coder/settings"], ["workspaces/coder/revues", "workspaces/coder/reviews"],
      ["tts-audiocpp/essai.wav", "tts-audiocpp/trial.wav"], ["plugins/exemple-minuteur", "plugins/example-timer"]]);
    expect(json("workspaces/coder/settings/notes.json")).toEqual({ a: 1 });
    expect(json("workspaces/coder/reviews/b.json")).toEqual({ b: 2 });
    expect(json("workspaces/brain-claude-cli/c.json")).toEqual({ c: 3 });
    expect(read("tts-audiocpp/trial.wav")).toBe("RIFF");
    expect(read("tts-audiocpp/essai.wav.bak-folders")).toBe("RIFF");
    expect(json("plugins/example-timer/index.json")).toEqual({ d: 4 });
    expect(step("folders", { force: true }).changes).toEqual([]);
  });

  it("la nouvelle place existe déjà : conflit signalé, les deux sont gardés", () => {
    put("workspaces/coder/reglages/a.json", { a: 1 });
    put("workspaces/coder/settings/z.json", { z: 1 });
    const r = step("folders");
    expect(r.skipped).toEqual([{ file: "workspaces/coder/reglages", why: "exists" }]);
    expect(has("workspaces/coder/reglages/a.json")).toBe(true);
    expect(has("workspaces/coder/settings/z.json")).toBe(true);
  });
});

// ---- Anciens réglages lus une fois par le code des plugins ----

describe("étape connectors-settings", () => {
  const YML = "plugins:\n  - { id: tools, plugin: tools, config: { servers: { a: { command: x }, \"B-2\": { command: y }, c: { command: z } } } }\n  - { id: ailleurs, plugin: contoso }\n";

  it("réglages connecteur_<id> : éteint → disabled, allumé → extra.enabled, une seule fois ; réglages retirés ; même état que l'ancien code", () => {
    write("floppy.yml", YML);
    put("settings.json", { connecteur_a: false, connecteur_b_2: true, connecteur_autre: false, "tasks.x.y": "never" });
    put("items/tools.json", { added: { ajout: { kind: "command", values: {} } }, edits: {}, disabled: ["c"], removed: [], children: {}, extra: { enabled: ["b-nope"] } });
    put("settings.json", { connecteur_a: false, connecteur_b_2: true, connecteur_ajout: false, connecteur_autre: false, "tasks.x.y": "never" });
    const r = step("connectors-settings");
    expect(r.changes.map((c) => c.file)).toEqual(["items/tools.json", "settings.json"]);
    expect(r.changes[0]!.keys).toEqual(["disabled", "extra.enabled", "extra.migrated"]);
    const items = json("items/tools.json");
    expect(items.disabled).toEqual(["c", "a", "ajout"]);
    expect(items.extra).toEqual({ enabled: ["b-nope", "B-2"], migrated: true });
    expect(json("settings.json")).toEqual({ "tasks.x.y": "never" });
    // Lu par l'ItemStore du noyau : les mêmes valeurs que l'ancien code.
    const store = ItemStore.in(home, "tools");
    expect(store.isEnabled("a")).toBe(false);
    expect(store.isEnabled("B-2")).toBe(true);
    expect(store.data.extra.enabled).toContain("B-2");
    expect(step("connectors-settings", { force: true }).changes).toEqual([]);
  });

  it("déjà migré (extra.migrated) : le fichier d'éléments n'est pas touché ; fichier absent : créé ; à blanc : rien d'écrit", () => {
    write("floppy.yml", YML);
    put("settings.json", { connecteur_a: false });
    put("items/tools.json", { added: {}, edits: {}, disabled: [], removed: [], children: {}, extra: { migrated: true } });
    const done = step("connectors-settings");
    expect(done.changes).toEqual([{ file: "settings.json", keys: ["connecteur_a"] }]);
    expect(json("items/tools.json").disabled).toEqual([]);
    rmSync(join(home, "items", "tools.json"));
    put("settings.json", { connecteur_c: false });
    expect(step("connectors-settings", { force: true, dryRun: true }).changes.map((c) => c.file)).toEqual(["items/tools.json", "settings.json"]);
    expect(has("items/tools.json")).toBe(false);
    step("connectors-settings", { force: true });
    expect(json("items/tools.json")).toMatchObject({ disabled: ["c"], extra: { enabled: [], migrated: true } });
  });
});

describe("étape wakeword-words", () => {
  it("l'ancien réglage mot_activation devient les mots de l'entrée (un choix déjà fait ou la config gagnent) ; réglage retiré", () => {
    write("floppy.yml", "plugins:\n  - { id: stt, plugin: wakeword-stt }\n  - { id: stt2, plugin: wakeword-stt, config: { words: [mimi] } }\n  - { id: stt3, plugin: wakeword-stt }\n");
    put("settings.json", { mot_activation: "jarvis, salut robot;  ", other: 1 });
    put("items/stt3.json", { added: {}, edits: { account: { words: ["deja"], name: "Mon nom" } }, disabled: [], removed: [], children: {}, extra: {} });
    const r = step("wakeword-words");
    expect(r.changes.map((c) => c.file)).toEqual(["items/stt.json", "settings.json"]);
    expect(json("items/stt.json").edits).toEqual({ account: { words: ["jarvis", "salut robot"] } });
    expect(has("items/stt2.json")).toBe(false);
    expect(json("items/stt3.json").edits.account).toEqual({ words: ["deja"], name: "Mon nom" });
    expect(json("settings.json")).toEqual({ other: 1 });
    // Lu comme le plugin le lit : la fusion de l'ItemStore donne les mots repris.
    expect(ItemStore.in(home, "stt").merge({ account: { words: undefined } }).account).toEqual({ words: ["jarvis", "salut robot"] });
    expect(step("wakeword-words", { force: true }).changes).toEqual([]);
  });

  it("réglage vide ou absent : rien à reprendre", () => {
    write("floppy.yml", "plugins:\n  - { id: stt, plugin: wakeword-stt }\n");
    expect(step("wakeword-words").changes).toEqual([]);
    put("settings.json", { mot_activation: "" });
    const r = step("wakeword-words", { force: true });
    expect(r.changes).toEqual([{ file: "settings.json", keys: ["mot_activation"] }]);
    expect(has("items/stt.json")).toBe(false);
  });
});

describe("étape orca-surveillance", () => {
  it("surveillance éteinte : annonces coupées (orca_notifications none) sauf choix déjà fait ; allumée : rien ; réglage retiré", () => {
    put("settings.json", { orca_surveillance: false, other: 1 });
    expect(step("orca-surveillance").changes).toEqual([{ file: "settings.json", keys: ["orca_surveillance", "orca_notifications"] }]);
    expect(json("settings.json")).toEqual({ other: 1, orca_notifications: "none" });
    put("settings.json", { orca_surveillance: false, orca_notifications: "all" });
    step("orca-surveillance", { force: true });
    expect(json("settings.json")).toEqual({ orca_notifications: "all" });
    put("settings.json", { orca_surveillance: true });
    step("orca-surveillance", { force: true });
    expect(json("settings.json")).toEqual({});
    expect(step("orca-surveillance", { force: true }).changes).toEqual([]);
  });
});

describe("les étapes 30 à 37 ensemble", () => {
  it("un dossier d'avant : tout passe en un passage, rien ne reste d'ancien, le second passage et le rejeu forcé ne changent rien", () => {
    seed30();
    put("veille/preferences.json", { likes: ["a"] });
    oldWatchDb("veille/veille.db");
    write("documents/a.md", '---\ntitle: "V"\ndate: 2026-11-06T08:00:00.000Z\nsource: "veille"\ntags: ["veille"]\n---\n\ncorps\n');
    put("workspaces/coder/reglages/n.json", {});
    const first = migrateHome(home);
    expect(first.filter((r) => r.error)).toEqual([]);
    for (const old of ["veille", "workspaces/coder/reglages", "items/veille.json"]) expect(has(old)).toBe(false);
    expect(has("watch/watch.db")).toBe(true);
    expect(read("floppy.yml")).toContain("id: watch");
    expect(migrateHome(home).every((r) => r.alreadyApplied)).toBe(true);
    const forced = migrateHome(home, { force: true });
    expect(forced.flatMap((r) => r.changes)).toEqual([]);
    expect(forced.flatMap((r) => r.skipped)).toEqual([]);
  });
});
