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
// - Une étape qui échoue ne bloque pas le démarrage : elle est signalée, n'entre pas dans le marqueur, et repart au
//   prochain démarrage. Les étapes suivantes tournent quand même.
import { constants, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "./files.ts";

/** Ce qu'une étape change (ou changerait) dans un fichier : seulement des NOMS de clés, jamais de valeurs. */
export interface MigrationChange {
  /** Chemin relatif au répertoire de travail, avec des « / ». */
  file: string;
  keys: string[];
}

/** Deux noms d'une même chose présents ensemble : le nouveau est gardé (le fichier est quand même mis à niveau), seul le NOM de la clé est rapporté. */
export interface MigrationConflict {
  file: string;
  key: string;
}

/** Un fichier laissé tel quel, et pourquoi. */
export interface MigrationSkip {
  file: string;
  why: "unreadable" | "conflict";
}

export interface MigrationEnv {
  home: string;
  /** À blanc : lit et rapporte, n'écrit rien (ni sauvegarde, ni fichier, ni marqueur). */
  dryRun: boolean;
  /** Fichier JSON (objet) : `edit` le modifie sur place et rend les noms des clés changées. Rien de rendu : fichier intact. */
  editJson(rel: string, edit: (data: Record<string, unknown>) => string[]): void;
  /** Fichier texte : `edit` rend le nouveau texte et les noms des clés changées, ou undefined (rien à changer). */
  editText(rel: string, edit: (text: string) => { text: string; keys: string[] } | undefined): void;
  /** Noms des fichiers d'un dossier (relatifs au répertoire de travail) ; dossier absent : liste vide. */
  list(relDir: string, ext: string): string[];
  /** Un fichier est laissé tel quel (conflit entre deux clés, etc.). */
  skip(rel: string, why: MigrationSkip["why"]): void;
  /** Deux clés pour la même chose : l'étape garde la nouvelle et le dit (nom de la clé seulement). */
  conflict(rel: string, key: string): void;
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

function environment(home: string, step: MigrationStep, dryRun: boolean, out: { changes: MigrationChange[]; skipped: MigrationSkip[]; conflicts: MigrationConflict[] }): MigrationEnv {
  const abs = (r: string) => join(home, ...r.split("/"));
  return {
    home,
    dryRun,
    editJson(r, edit) {
      const file = abs(r);
      if (!existsSync(file)) return;
      let data: unknown;
      try { data = JSON.parse(readFileSync(file, "utf8")); } catch { out.skipped.push({ file: r, why: "unreadable" }); return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) { out.skipped.push({ file: r, why: "unreadable" }); return; }
      const keys = edit(data as Record<string, unknown>);
      if (!keys.length) return;
      out.changes.push({ file: r, keys });
      if (dryRun) return;
      backup(file, step.id);
      writeJsonAtomic(file, data);
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
    conflict(r, key) { if (!out.conflicts.some((c) => c.file === r && c.key === key)) out.conflicts.push({ file: r, key }); },
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
        if (out.changes.length) log("info", `migration ${step.id} : ${out.changes.length} fichier(s) mis à niveau (${out.changes.map((c) => c.file).join(", ")})`);
        for (const c of out.conflicts) log("warn", `migration ${step.id} : ${c.file} : la clé « ${c.key} » existe sous ses deux noms, le nouveau est gardé`);
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
