// Fichiers de l'utilisateur : écriture sans risque de fichier à moitié écrit, lecture qui ne perd rien en silence.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Écrit dans un fichier temporaire, puis le renomme : un plantage pendant l'écriture laisse l'ancien fichier intact.
 * Windows : un antivirus ou un indexeur peut tenir le fichier un instant (EPERM, EBUSY) ; on réessaie un peu.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, typeof data === "string" ? { encoding: "utf8", mode: opts.mode } : { mode: opts.mode });
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        try { rmSync(tmp, { force: true }); } catch { /* rien */ }
        throw e;
      }
      Atomics.wait(pause, 0, 0, 20 * (i + 1));
    }
  }
}

/** JSON lisible par un humain, écrit de façon atomique. */
export function writeJsonAtomic(file: string, value: unknown, opts: { mode?: number } = {}): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", opts);
}

/** Lecteur de fichiers abîmés : par défaut un avertissement dans le journal du noyau. */
export type CorruptReport = (file: string, movedTo: string, error: unknown) => void;
let report: CorruptReport = (file, movedTo, error) =>
  console.warn(`[files] fichier illisible mis de côté : ${file} → ${movedTo} (${error instanceof Error ? error.message : String(error)})`);
const corrupt: { file: string; movedTo: string; at: string }[] = [];

/** Remplace le rapporteur (tests, ou le noyau qui veut le montrer à l'utilisateur). Rend l'ancien. */
export function onCorruptFile(fn: CorruptReport): CorruptReport { const old = report; report = fn; return old; }

/** Fichiers mis de côté depuis le démarrage (pour `floppy status` et la fenêtre). */
export function corruptFiles(): readonly { file: string; movedTo: string; at: string }[] { return corrupt; }

/**
 * Lit un fichier JSON. Absent : `undefined`. Illisible : le fichier est renommé en `<nom>.corrupt-<date>`
 * (jamais écrasé par la sauvegarde suivante), le problème est signalé, et on rend `undefined`.
 */
export function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) { setAside(file, e); return undefined; }
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as T; } catch (e) { setAside(file, e); return undefined; }
}

function setAside(file: string, error: unknown): void {
  const at = new Date().toISOString();
  const movedTo = `${file}.corrupt-${at.replace(/[:.]/g, "-")}`;
  try { renameSync(file, movedTo); } catch { /* fichier verrouillé : on le laisse, il sera réécrit plus tard */ }
  corrupt.push({ file, movedTo, at });
  try { report(file, movedTo, error); } catch { /* rien */ }
}
