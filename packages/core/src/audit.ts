// Journal d'audit en ajout seul (JSONL) : chaque outil appelé, ses paramètres, l'accord, le résultat.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditRecord {
  kind: string;
  [key: string]: unknown;
}

export interface Audit {
  write(rec: AuditRecord): void;
  /** Les n derniers enregistrements (le plus récent en dernier). */
  tail(n?: number): (AuditRecord & { t: string })[];
}

export class FileAudit implements Audit {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  write(rec: AuditRecord): void {
    appendFileSync(this.path, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n", "utf8");
  }
  tail(n = 50): (AuditRecord & { t: string })[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").trimEnd().split("\n").filter(Boolean);
    const out: (AuditRecord & { t: string })[] = [];
    for (const l of lines.slice(-n)) {
      try { out.push(JSON.parse(l)); } catch { /* ligne abîmée (écriture coupée) : ignorée */ }
    }
    return out;
  }
}

export class MemoryAudit implements Audit {
  readonly records: (AuditRecord & { t: string })[] = [];
  write(rec: AuditRecord): void {
    this.records.push({ t: new Date().toISOString(), ...rec });
  }
  tail(n = 50): (AuditRecord & { t: string })[] {
    return this.records.slice(-n);
  }
}
