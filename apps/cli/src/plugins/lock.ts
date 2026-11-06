// Verrou des plugins tiers installés : <home>/plugins/lock.json.
// Il garde, pour chaque plugin, d'où il vient et l'empreinte du contenu relu. Au démarrage, un plugin dont les
// fichiers ne correspondent plus à cette empreinte ne démarre pas (voir sandbox.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./review.ts";
import type { SourceKind } from "./source.ts";

export interface LockEntry {
  id: string;
  version: string;
  source: string;
  kind: SourceKind;
  ref?: string;
  commit?: string;
  /** sha256 du contenu relu (check.ts : hashFiles). */
  hash: string;
  installedAt: string;
  review: { verdict: Verdict; agent: string; at: string; summary: string };
}

export type Lock = Record<string, LockEntry>;

export const lockFile = (home: string): string => join(home, "plugins", "lock.json");

export function readLock(home: string): Lock {
  const f = lockFile(home);
  if (!existsSync(f)) return {};
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { plugins?: Lock };
    return j.plugins && typeof j.plugins === "object" ? j.plugins : {};
  } catch { return {}; }
}

export function writeLock(home: string, lock: Lock): void {
  const f = lockFile(home);
  mkdirSync(join(home, "plugins"), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify({ version: 1, plugins: lock }, null, 2) + "\n", "utf8");
  renameSync(f + ".tmp", f);
}
