// Programmes lancés par le noyau (ctx.spawn), notés dans <home>/children.json.
// Si le noyau est tué de force, leurs fermetures ne tournent pas : au démarrage suivant, on arrête ceux qui tournent encore.
// Un numéro de processus peut être réutilisé par le système : on vérifie aussi le nom du programme avant d'arrêter.
import { execFile, type ChildProcess } from "node:child_process";
import { basename, extname } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./files.ts";

export interface ChildRecord { pid: number; name: string; owner: string; at: string }

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
    this.live.set(pid, { pid, name: programBase(command), owner, at: new Date().toISOString() });
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
  /** Nom (sans extension, minuscules) du programme qui tourne sous ce numéro, ou undefined s'il n'y en a plus. */
  nameOf(pid: number): Promise<string | undefined>;
  /** Arrête ce processus et ses enfants. */
  kill(pid: number): Promise<void>;
}

/** Arrête les programmes notés par une session précédente qui tournent encore sous le même nom. Rend ceux arrêtés. */
export async function reapOrphans(file: string, deps: ReapDeps = systemReapDeps): Promise<ChildRecord[]> {
  const old = readJsonFile<ChildRecord[]>(file);
  if (!Array.isArray(old) || !old.length) return [];
  const killed: ChildRecord[] = [];
  for (const r of old) {
    if (!r || typeof r.pid !== "number" || r.pid === process.pid || typeof r.name !== "string") continue;
    const name = await deps.nameOf(r.pid).catch(() => undefined);
    if (!name || name !== r.name) continue;
    await deps.kill(r.pid).catch(() => {});
    killed.push(r);
  }
  return killed;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (_e, out) => resolve(String(out ?? ""))));

export const systemReapDeps: ReapDeps = {
  async nameOf(pid) {
    if (process.platform === "win32") {
      // "llama-server.exe","1234","Console","1","123 456 K"
      const line = (await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])).trim();
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      return m && Number(m[2]) === pid ? programBase(m[1]!) : undefined;
    }
    const name = (await run("ps", ["-p", String(pid), "-o", "comm="])).trim();
    return name ? programBase(name) : undefined;
  },
  async kill(pid) {
    if (process.platform === "win32") { await run("taskkill", ["/pid", String(pid), "/T", "/F"]); return; }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* déjà parti */ } }
  },
};
