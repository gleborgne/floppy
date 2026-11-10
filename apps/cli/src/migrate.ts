// `floppy migrate` : met à niveau les fichiers de l'utilisateur sans lancer l'assistant (voir packages/core/src/util/home-migration.ts).
// Par défaut « à blanc » : dit quels fichiers et quelles clés CHANGERAIENT (des noms de clés, jamais de valeurs) et n'écrit rien.
// `--apply` : applique (une sauvegarde `<fichier>.bak-<étape>` est écrite à côté avant la première modification).
import { migrateHome, HOME_MIGRATIONS } from "@floppy/setup";
import type { MigrationReport } from "@floppy/core";

export interface MigrateOptions {
  apply?: boolean;
  /** Rejoue même les étapes déjà notées dans le marqueur (après une restauration de sauvegarde). */
  force?: boolean;
}

/** Les lignes à afficher ; `code` : 0, ou 1 si une étape a échoué. */
export function migrateCommand(home: string, opts: MigrateOptions, say: (fr: string, en: string) => string): { lines: string[]; code: number; reports: MigrationReport[] } {
  const dryRun = opts.apply !== true;
  const reports = migrateHome(home, { dryRun, ...(opts.force ? { force: true } : {}) });
  const lines: string[] = [say(
    `Mise à niveau des données${dryRun ? " (à blanc : rien n'est écrit)" : ""} — dossier : ${home}`,
    `Data upgrade${dryRun ? " (dry run: nothing is written)" : ""} — folder: ${home}`,
  )];
  let changed = 0;
  for (const r of reports) {
    const label = HOME_MIGRATIONS.find((s) => s.id === r.step)?.label ?? "";
    if (r.alreadyApplied) { lines.push(`[${r.step}] ${say("déjà faite", "already done")}`); continue; }
    if (r.error) { lines.push(`[${r.step}] ${say("ÉCHEC", "FAILED")} : ${r.error}`); continue; }
    if (!r.changes.length) lines.push(`[${r.step}] ${say("rien à changer", "nothing to change")}`);
    else lines.push(`[${r.step}] ${label} — ${say(dryRun ? `${r.changes.length} fichier(s) à modifier` : `${r.changes.length} fichier(s) modifié(s)`, dryRun ? `${r.changes.length} file(s) to change` : `${r.changes.length} file(s) changed`)}`);
    for (const c of r.changes) { changed++; lines.push(c.renamedTo ? `  ${c.file} → ${c.renamedTo}` : `  ${c.file} : ${c.keys.join(", ")}`); }
    for (const s of r.skipped) lines.push(`  ${s.file} : ${s.why === "unreadable" ? say("illisible, laissé tel quel", "unreadable, left as is") : s.why === "exists" ? say("la nouvelle place existe déjà : rien n'est changé, les deux sont laissés", "the new location already exists: nothing is changed, both are left") : say("conflit entre deux clés, laissé tel quel", "two keys in conflict, left as is")}`);
    for (const c of r.conflicts ?? []) lines.push(`  ${c.file} : ${c.key} (${c.kept === "both" ? say("les deux noms sont présents : rien n'est changé", "both names are present: nothing is changed") : say("les deux noms sont présents : le nouveau est gardé", "both names are present: the new one is kept")})`);
  }
  if (dryRun) lines.push(changed ? say("Rien n'a été modifié. Pour appliquer (après une sauvegarde du dossier) : floppy migrate --apply", "Nothing was changed. To apply (after backing up the folder): floppy migrate --apply") : say("Rien à faire.", "Nothing to do."));
  else lines.push(say(`Terminé : ${changed} fichier(s) modifié(s). Les originaux sont gardés à côté (*.bak-<étape>).`, `Done: ${changed} file(s) changed. Originals are kept next to them (*.bak-<step>).`));
  return { lines, code: reports.some((r) => r.error) ? 1 : 0, reports };
}
