// Programmes lancés par le noyau (ctx.spawn), notés dans <home>/children.json.
// Si le noyau est tué de force, leurs fermetures ne tournent pas : au démarrage suivant, on arrête ceux qui tournent encore.
// Un numéro de processus peut être réutilisé par le système. On arrête donc seulement un programme :
// - dont le noyau qui l'a lancé ne tourne plus (sinon c'est une autre instance de Floppy, en marche) ;
// - qui porte le même nom ET a démarré au même moment (à 10 s près) que celui noté.
import { execFile, type ChildProcess } from "node:child_process";
import { basename, extname } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./files.ts";

export interface ChildRecord {
  pid: number;
  name: string;
  owner: string;
  /** Heure du lancement (ISO). */
  at: string;
  /** Processus du noyau qui l'a lancé. */
  kernel?: number;
}

/** Nom du programme sans dossier ni extension, en minuscules (comparaison entre systèmes). */
export const programBase = (command: string): string => basename(command, extname(command)).toLowerCase();

export class ChildRegistry {
  private readonly file: string | undefined;
  private readonly live = new Map<number, ChildRecord>();

  /** Sans fichier (tests) : rien n'est écrit. */
  constructor(file?: string) { this.file = file; }

  track(child: ChildProcess, command: string, owner: string): void {
    const pid = child.pid;
    if (pid === undefined) return;
    this.live.set(pid, { pid, name: programBase(command), owner, at: new Date().toISOString(), kernel: process.pid });
    this.save();
    child.once("exit", () => { this.live.delete(pid); this.save(); });
  }

  list(): ChildRecord[] { return [...this.live.values()]; }

  private save(): void {
    if (!this.file) return;
    try { writeJsonAtomic(this.file, this.list()); } catch { /* disque plein : la liste reste en mémoire */ }
  }
}

export interface ReapDeps {
  /** Ce qui tourne sous ce numéro : nom (sans extension, minuscules) et heure de démarrage (ms), ou undefined. */
  infoOf(pid: number): Promise<{ name: string; startedAt?: number } | undefined>;
  /** Le processus tourne-t-il encore ? (le noyau d'une autre instance) */
  alive(pid: number): boolean;
  /** Arrête ce processus et ses enfants. */
  kill(pid: number): Promise<void>;
}

/** Écart permis entre l'heure notée et l'heure de démarrage lue (lancement, lenteur de la lecture). */
const SAME_START_MS = 10_000;

/**
 * Arrête les programmes notés par une session précédente qui tournent encore (même nom, même heure de démarrage,
 * noyau disparu). Récrit ensuite la liste avec seulement ceux d'une instance encore en marche. Rend ceux arrêtés.
 */
export async function reapOrphans(file: string, deps: ReapDeps = systemReapDeps): Promise<ChildRecord[]> {
  let old: ChildRecord[] | undefined;
  try { old = readJsonFile<ChildRecord[]>(file); } catch { return []; }
  if (!Array.isArray(old) || !old.length) return [];
  const killed: ChildRecord[] = [];
  const kept: ChildRecord[] = [];
  for (const r of old) {
    if (!r || typeof r.pid !== "number" || r.pid === process.pid || typeof r.name !== "string") continue;
    // Le noyau qui l'a lancé tourne encore : c'est une autre instance de Floppy, on n'y touche pas.
    if (typeof r.kernel === "number" && r.kernel !== process.pid && deps.alive(r.kernel)) { kept.push(r); continue; }
    const info = await deps.infoOf(r.pid).catch(() => undefined);
    if (!info || info.name !== r.name) continue;
    const at = Date.parse(r.at);
    // Heure de démarrage inconnue, ou différente : un autre programme a repris ce numéro. On ne l'arrête pas.
    if (info.startedAt === undefined || !Number.isFinite(at) || Math.abs(info.startedAt - at) > SAME_START_MS) continue;
    await deps.kill(r.pid).catch(() => {});
    killed.push(r);
  }
  try { writeJsonAtomic(file, kept); } catch { /* sans gravité : relu au prochain démarrage */ }
  return killed;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (_e, out) => resolve(String(out ?? ""))));

export const systemReapDeps: ReapDeps = {
  async infoOf(pid) {
    if (process.platform === "win32") {
      // « llama-server|2026-11-07T10:00:00.0000000Z » : nom sans extension et heure de démarrage.
      const out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`])).trim();
      const cut = out.indexOf("|");
      if (cut < 1) return undefined;
      const t = Date.parse(out.slice(cut + 1));
      return { name: programBase(out.slice(0, cut)), ...(Number.isFinite(t) ? { startedAt: t } : {}) };
    }
    const name = (await run("ps", ["-p", String(pid), "-o", "comm="])).trim();
    if (!name) return undefined;
    const t = Date.parse((await run("ps", ["-p", String(pid), "-o", "lstart="])).trim());
    return { name: programBase(name), ...(Number.isFinite(t) ? { startedAt: t } : {}) };
  },
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  },
  async kill(pid) {
    if (process.platform === "win32") { await run("taskkill", ["/pid", String(pid), "/T", "/F"]); return; }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* déjà parti */ } }
  },
};
