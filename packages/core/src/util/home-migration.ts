// Migration du répertoire de travail : un petit moteur, versionné et sans danger, qui met à niveau les fichiers de
// l'utilisateur quand un identifiant change de nom (clé, valeur). Il ne connaît aucun fichier : les étapes (voir
// @floppy/setup, `HOME_MIGRATIONS`) disent quoi changer, le moteur s'occupe de la sécurité.
//
// Règles du moteur :
// - Il tourne au démarrage, AVANT que quoi que ce soit ne lise ces fichiers (voir apps/cli/src/boot.ts), ou à la main
//   (`floppy migrate`, avec un mode « à blanc » qui n'écrit rien).
// - Un marqueur `<home>/migrations.json` ({ version, applied }) retient les étapes déjà faites : chacune tourne une fois.
// - Une étape est idempotente : un fichier absent, déjà au nouveau format ou illisible n'est pas touché.
// - Avant la première modification d'un fichier, une copie `<fichier>.bak-<étape>` est écrite à côté (jamais écrasée).
// - Renommer un fichier : copie à la nouvelle place (jamais écrasée) puis l'original est mis de côté en `<fichier>.bak-<étape>`.
//   Renommer un dossier : déplacement d'un bloc (rien n'est copié ni effacé : les données arrivent entières à la nouvelle place).
//   La nouvelle place existe déjà : conflit signalé, les deux sont laissés tels quels.
// - Une base SQLite : renommer des tables et des colonnes (`ALTER TABLE … RENAME`), dans une transaction, après une copie
//   `<base>.bak-<étape>`. Base absente ou déjà au nouveau format : intacte. Base verrouillée ou illisible : l'étape échoue,
//   et repart au prochain démarrage.
// - Une étape qui échoue ne bloque pas le démarrage : elle est signalée, n'entre pas dans le marqueur, et repart au
//   prochain démarrage. Les étapes suivantes tournent quand même.
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "./files.ts";

/** Ce qu'une étape change (ou changerait) dans un fichier : seulement des NOMS de clés, jamais de valeurs. */
export interface MigrationChange {
  /** Chemin relatif au répertoire de travail, avec des « / ». */
  file: string;
  keys: string[];
  /** Fichier ou dossier renommé : sa nouvelle place (relative, avec des « / »). `keys` est alors vide. */
  renamedTo?: string;
}

/**
 * Deux noms d'une même chose présents ensemble, seul le NOM de la clé est rapporté.
 * `kept: "new"` (défaut) : le nouveau est gardé, l'ancien retiré ; `"both"` : rien n'est changé, les deux sont laissés.
 */
export interface MigrationConflict {
  file: string;
  key: string;
  kept?: "new" | "both";
}

/** Un fichier laissé tel quel, et pourquoi (`exists` : la nouvelle place d'un renommage est déjà prise). */
export interface MigrationSkip {
  file: string;
  why: "unreadable" | "conflict" | "exists";
}

/** Une base SQLite vue par une étape : seulement des renommages de tables et de colonnes (les noms sont vérifiés). */
export interface SqliteEdit {
  tables(): string[];
  columns(table: string): string[];
  /** Renomme la table `from` en `to` (absente : rien ; les deux présentes : conflit, rien n'est changé). */
  renameTable(from: string, to: string): void;
  /** Renomme la colonne `from` de `table` en `to` (absente : rien ; les deux présentes : conflit, rien n'est changé). */
  renameColumn(table: string, from: string, to: string): void;
}

export interface MigrationEnv {
  home: string;
  /** À blanc : lit et rapporte, n'écrit rien (ni sauvegarde, ni fichier, ni marqueur). */
  dryRun: boolean;
  /**
   * Fichier JSON (objet) : `edit` le modifie sur place et rend les noms des clés changées. Rien de rendu : fichier intact.
   * `create` : fichier absent, `edit` reçoit un objet vide et le fichier est écrit s'il rend des clés (pas de sauvegarde : il n'y a pas d'original).
   */
  editJson(rel: string, edit: (data: Record<string, unknown>) => string[], opts?: { create?: boolean }): void;
  /** Renomme un fichier ou un dossier (voir les règles du moteur). Absent : rien. Nouvelle place prise : conflit, rien n'est changé. */
  renamePath(from: string, to: string): void;
  /** Base SQLite : `edit` renomme des tables et des colonnes. Rien à changer : base intacte. Verrouillée ou illisible : lève (étape retentée). */
  editSqlite(rel: string, edit: (db: SqliteEdit) => void): void;
  /** Fichier texte : `edit` rend le nouveau texte et les noms des clés changées, ou undefined (rien à changer). */
  editText(rel: string, edit: (text: string) => { text: string; keys: string[] } | undefined): void;
  /** Noms des fichiers d'un dossier (relatifs au répertoire de travail) ; dossier absent : liste vide. */
  list(relDir: string, ext: string): string[];
  /** Un fichier est laissé tel quel (conflit entre deux clés, etc.). */
  skip(rel: string, why: MigrationSkip["why"]): void;
  /** Deux noms pour la même chose : par défaut l'étape garde le nouveau et le dit (nom de la clé seulement) ; `kept: "both"` : rien n'est changé. */
  conflict(rel: string, key: string, kept?: "new" | "both"): void;
  /** Texte d'un fichier, en lecture seule (par ex. pour savoir quel plugin porte une entrée) ; absent ou illisible : undefined. */
  read(rel: string): string | undefined;
}

export interface MigrationStep {
  /** Nom stable : sert au marqueur et au suffixe `.bak-<id>` des sauvegardes. */
  id: string;
  /** Rang (1, 2, 3…) : l'ordre d'exécution, et le « version » du marqueur. */
  version: number;
  /** Ce que fait l'étape (journal, en français). */
  label: string;
  run(env: MigrationEnv): void;
}

export interface MigrationReport {
  step: string;
  /** Déjà faite avant ce passage (marqueur) : rien n'a été relu. */
  alreadyApplied: boolean;
  changes: MigrationChange[];
  skipped: MigrationSkip[];
  /** Clés présentes sous leurs deux noms (présent seulement s'il y en a). */
  conflicts?: MigrationConflict[];
  /** Échec de l'étape : signalé, retenté au prochain démarrage. */
  error?: string;
}

export interface MigrationMarker {
  version: number;
  applied: Record<string, string>;
}

export interface MigrationOptions {
  dryRun?: boolean;
  /** Ignore le marqueur : rejoue toutes les étapes (elles sont idempotentes), par ex. après une restauration de sauvegarde. */
  force?: boolean;
  log?: (level: "info" | "warn", msg: string) => void;
  now?: () => Date;
}

export const MIGRATION_MARKER = "migrations.json";

/** Lit le marqueur ; absent ou abîmé : aucune étape faite (les étapes sont idempotentes). */
export function readMigrationMarker(home: string): MigrationMarker {
  let m: Partial<MigrationMarker> | undefined;
  try { m = readJsonFile<Partial<MigrationMarker>>(join(home, MIGRATION_MARKER)); } catch { m = undefined; }
  const applied = m && typeof m.applied === "object" && m.applied ? Object.fromEntries(Object.entries(m.applied).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
  return { version: typeof m?.version === "number" ? m.version : 0, applied };
}

/** Copie `<fichier>.bak-<étape>` à côté, une seule fois : la première copie est l'original. */
function backup(file: string, stepId: string): void {
  try { copyFileSync(file, `${file}.bak-${stepId}`, constants.COPYFILE_EXCL); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Les tables d'une base et leurs colonnes, tenues à jour au fil des renommages. `run` : exécuter vraiment (sinon seulement noter, pour le rapport à blanc). */
function sqliteEdit(db: import("node:sqlite").DatabaseSync, run: boolean, keys: string[], conflicts: string[]): SqliteEdit {
  const schema = new Map<string, string[]>();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of rows) {
    if (!SQL_NAME.test(name)) continue;
    schema.set(name, (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name));
  }
  const check = (...names: string[]) => { for (const n of names) if (!SQL_NAME.test(n)) throw new Error(`nom SQL refusé : ${n}`); };
  return {
    tables: () => [...schema.keys()],
    columns: (t) => [...(schema.get(t) ?? [])],
    renameTable(from, to) {
      check(from, to);
      const cols = schema.get(from);
      if (!cols) return;
      if (schema.has(to)) { conflicts.push(`${from} → ${to}`); return; }
      if (run) db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
      schema.delete(from);
      schema.set(to, cols);
      keys.push(`${from} → ${to}`);
    },
    renameColumn(table, from, to) {
      check(table, from, to);
      const cols = schema.get(table);
      if (!cols || !cols.includes(from)) return;
      if (cols.includes(to)) { conflicts.push(`${table}.${from} → ${to}`); return; }
      if (run) db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`);
      cols[cols.indexOf(from)] = to;
      keys.push(`${table}.${from} → ${to}`);
    },
  };
}

function environment(home: string, step: MigrationStep, dryRun: boolean, out: { changes: MigrationChange[]; skipped: MigrationSkip[]; conflicts: MigrationConflict[] }): MigrationEnv {
  const abs = (r: string) => join(home, ...r.split("/"));
  return {
    home,
    dryRun,
    editJson(r, edit, opts) {
      const file = abs(r);
      let data: unknown;
      const created = !existsSync(file);
      if (created) {
        if (!opts?.create) return;
        data = {};
      } else {
        try { data = JSON.parse(readFileSync(file, "utf8")); } catch { out.skipped.push({ file: r, why: "unreadable" }); return; }
        if (!data || typeof data !== "object" || Array.isArray(data)) { out.skipped.push({ file: r, why: "unreadable" }); return; }
      }
      const keys = edit(data as Record<string, unknown>);
      if (!keys.length) return;
      out.changes.push({ file: r, keys });
      if (dryRun) return;
      if (!created) backup(file, step.id);
      writeJsonAtomic(file, data);
    },
    renamePath(from, to) {
      const src = abs(from);
      const dst = abs(to);
      if (!existsSync(src)) return;
      if (existsSync(dst)) { out.skipped.push({ file: from, why: "exists" }); return; }
      out.changes.push({ file: from, keys: [], renamedTo: to });
      if (dryRun) return;
      mkdirSync(dirname(dst), { recursive: true });
      if (statSync(src).isDirectory()) { renameSync(src, dst); return; }
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      const bak = `${src}.bak-${step.id}`;
      // Une sauvegarde déjà là (essai précédent) garde l'original : la copie qu'on vient de faire est identique, on retire l'ancienne place.
      if (existsSync(bak)) rmSync(src); else renameSync(src, bak);
    },
    editSqlite(r, edit) {
      const file = abs(r);
      if (!existsSync(file)) return;
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const fail = (e: unknown): never => { throw new Error(`${r} : ${e instanceof Error ? e.message : String(e)}`); };
      const keys: string[] = [];
      const conflicts: string[] = [];
      // 1. Lecture seule : ce qui changerait (aussi le rapport à blanc). Une base déjà au nouveau format : rien.
      let ro: InstanceType<typeof DatabaseSync> | undefined;
      try {
        ro = new DatabaseSync(file, { readOnly: true });
        edit(sqliteEdit(ro, false, keys, conflicts));
      } catch (e) { fail(e); } finally { try { ro?.close(); } catch { /* rien */ } }
      for (const c of conflicts) out.conflicts.push({ file: r, key: c, kept: "both" });
      if (!keys.length) return;
      out.changes.push({ file: r, keys });
      if (dryRun) return;
      // 2. Copie de la base, puis les renommages dans une transaction (tout ou rien).
      backup(file, step.id);
      let rw: InstanceType<typeof DatabaseSync> | undefined;
      try {
        rw = new DatabaseSync(file, { timeout: 5000 });
        rw.exec("BEGIN IMMEDIATE");
        try { edit(sqliteEdit(rw, true, [], [])); rw.exec("COMMIT"); } catch (e) { try { rw.exec("ROLLBACK"); } catch { /* rien */ } throw e; }
      } catch (e) { fail(e); } finally { try { rw?.close(); } catch { /* rien */ } }
    },
    editText(r, edit) {
      const file = abs(r);
      if (!existsSync(file)) return;
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { out.skipped.push({ file: r, why: "unreadable" }); return; }
      const res = edit(text);
      if (!res || !res.keys.length) return;
      out.changes.push({ file: r, keys: res.keys });
      if (dryRun) return;
      backup(file, step.id);
      writeFileAtomic(file, res.text);
    },
    list(relDir, ext) {
      const dir = abs(relDir);
      if (!existsSync(dir)) return [];
      let names: string[];
      try { names = readdirSync(dir); } catch { return []; }
      return names.filter((n) => n.endsWith(ext)).sort().map((n) => `${relDir}/${n}`);
    },
    skip(r, why) { out.skipped.push({ file: r, why }); },
    conflict(r, key, kept = "new") { if (!out.conflicts.some((c) => c.file === r && c.key === key)) out.conflicts.push({ file: r, key, ...(kept === "both" ? { kept } : {}) }); },
    read(r) {
      try { return readFileSync(abs(r), "utf8"); } catch { return undefined; }
    },
  };
}

/**
 * Passe les étapes qui ne sont pas dans le marqueur, dans l'ordre. Ne lève jamais : un échec est dans le rapport.
 * À blanc : rien n'est écrit, pas même le marqueur.
 */
export function runHomeMigrations(home: string, steps: readonly MigrationStep[], opts: MigrationOptions = {}): MigrationReport[] {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? (() => {});
  const marker = readMigrationMarker(home);
  const reports: MigrationReport[] = [];
  let dirty = false;
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (!opts.force && marker.applied[step.id]) { reports.push({ step: step.id, alreadyApplied: true, changes: [], skipped: [] }); continue; }
    const out = { changes: [] as MigrationChange[], skipped: [] as MigrationSkip[], conflicts: [] as MigrationConflict[] };
    const report: MigrationReport = { step: step.id, alreadyApplied: false, changes: out.changes, skipped: out.skipped };
    try {
      step.run(environment(home, step, dryRun, out));
      if (!dryRun) {
        marker.applied[step.id] = (opts.now?.() ?? new Date()).toISOString();
        marker.version = Math.max(marker.version, step.version);
        dirty = true;
        if (out.changes.length) log("info", `migration ${step.id} : ${out.changes.length} fichier(s) mis à niveau (${out.changes.map((c) => (c.renamedTo ? `${c.file} → ${c.renamedTo}` : c.file)).join(", ")})`);
        for (const c of out.conflicts) log("warn", c.kept === "both" ? `migration ${step.id} : ${c.file} : « ${c.key} » : les deux noms existent, rien n'est changé` : `migration ${step.id} : ${c.file} : la clé « ${c.key} » existe sous ses deux noms, le nouveau est gardé`);
        for (const s of out.skipped) if (s.why === "exists") log("warn", `migration ${step.id} : ${s.file} : la nouvelle place existe déjà, rien n'est changé`);
      }
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      log("warn", `migration ${step.id} échouée (sera retentée au prochain démarrage) : ${report.error}`);
    }
    if (out.conflicts.length) report.conflicts = out.conflicts;
    reports.push(report);
  }
  if (dirty && !dryRun) {
    try { writeJsonAtomic(join(home, MIGRATION_MARKER), marker); } catch (e) {
      log("warn", `migration : marqueur non écrit (les étapes seront rejouées, elles sont sans effet) : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return reports;
}
