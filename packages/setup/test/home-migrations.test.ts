// Les étapes de migration livrées : en-tête des documents, niveau du premier lancement, puis réglages, configuration, éléments, boîte aux lettres et préférences de la veille.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationMarker, runHomeMigrations } from "@floppy/core";
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
    const r = migrateHome(home);
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
    expect(dry.flatMap((r) => r.changes)).toEqual([{ file: "documents/a.md", keys: ["titre"] }]);
    expect(existsSync(join(home, "migrations.json"))).toBe(false);
    expect(read("documents/a.md")).toBe(OLD_DOC);
    migrateHome(home);
    const marker = readMigrationMarker(home);
    expect(marker.version).toBe(Math.max(...HOME_MIGRATIONS.map((s) => s.version)));
    expect(Object.keys(marker.applied).sort()).toEqual(HOME_MIGRATIONS.map((s) => s.id).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Étapes 3 à 8 : réglages, configuration, éléments, boîte aux lettres, préférences de la veille.
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
      disabled: [], removed: [], children: { m365: { m365_ajouter_rdv: false } }, extra: { tools: { veille: [{ name: "veille_avis", description: "d", level: "write" }] } },
    });
    const r = step("items-fields");
    expect(r.changes[0]!.keys.sort()).toEqual(["added.values.dossier", "added.values.langue", "edits.langue", "edits.seuil"]);
    const d = json("items/apps.json");
    expect(d.added.sx2.values).toEqual({ url: "http://localhost:8888", language: "fr" });
    expect(d.added.ses.values).toEqual({ folder: "~/Travaux" });
    expect(d.added.etranger.values).toEqual({ langue: "fr" });
    expect(d.edits).toEqual({ web: { language: "en" }, veille: { threshold: 8 }, inconnu: { langue: "fr" } });
    // Les noms d'outils (lot suivant) et leurs réglages ne bougent pas.
    expect(d.children).toEqual({ m365: { m365_ajouter_rdv: false } });
    expect(d.extra.tools.veille[0].name).toBe("veille_avis");
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
    expect(first.filter((r) => r.changes.length).map((r) => r.step).sort()).toEqual(["config-yaml", "inbox-trust", "settings-keys", "settings-values"]);
    expect(first.every((r) => !r.error)).toBe(true);
    expect(json("settings.json")).toEqual({ tone: "x", orca_notifications: "none", "tasks.veille.quotidienne": "never" });
    expect(migrateHome(home).every((r) => r.alreadyApplied)).toBe(true);
    const forced = migrateHome(home, { force: true });
    expect(forced.flatMap((r) => r.changes)).toEqual([]);
  });

  it("les étapes déjà notées du lot 1 ne sont pas rejouées ; les nouvelles ont des versions croissantes et des noms uniques", () => {
    expect(HOME_MIGRATIONS.map((s) => s.version)).toEqual([1, 2, 3, 10, 11, 12, 13, 14, 15]);
    expect(new Set(HOME_MIGRATIONS.map((s) => s.id)).size).toBe(HOME_MIGRATIONS.length);
    writeFileSync(join(home, "migrations.json"), JSON.stringify({ version: 2, applied: { "documents-title": "x", "onboarding-level": "x" } }));
    put("settings.json", { ton: "x" });
    const r = migrateHome(home);
    expect(r.slice(0, 2).every((x) => x.alreadyApplied)).toBe(true);
    expect(r.slice(2).some((x) => x.changes.length)).toBe(true);
    expect(readMigrationMarker(home).version).toBe(15);
  });
});
