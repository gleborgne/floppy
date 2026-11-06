// Arrêt d'un processus et de tous ses enfants (Windows : taskkill /T ; ailleurs : groupe de processus).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Cherche un programme dans le PATH (Windows : .exe, .cmd, .bat). Rend son chemin complet, ou undefined.
 * `claude` est aussi cherché dans ~/.local/bin (son installeur l'y met sans toucher au PATH).
 */
export function findExe(name: string, extraDirs: string[] = []): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs];
  if (name === "claude") dirs.push(join(homedir(), ".local", "bin"));
  for (const d of dirs) for (const e of exts) {
    const f = join(d, name + e);
    if (existsSync(f)) return f;
  }
  return undefined;
}

export function killTree(child: ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    child.once("exit", done);
    const timer = setTimeout(done, graceMs);
    if (process.platform === "win32") {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.on("error", () => child.kill());
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  });
}

/** Comparaison de config : JSON avec clés triées. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "";
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val);
}
