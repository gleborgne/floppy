// Journal d'audit en ajout seul (JSONL) : chaque outil appelé, ses paramètres, l'accord, le résultat.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
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
  private readonly maxBytes: number;
  private size: number;
  /**
   * `maxBytes` : au-delà, le journal devient `<nom>.1.jsonl` (l'ancien est remplacé) et un nouveau commence.
   * Le journal ne grossit donc jamais sans limite.
   */
  constructor(path: string, opts: { maxBytes?: number } = {}) {
    this.path = path;
    this.maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }
  write(rec: AuditRecord): void {
    const line = JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n";
    try {
      if (this.size > 0 && this.size + line.length > this.maxBytes) {
        renameSync(this.path, this.path.replace(/(\.jsonl)?$/, ".1.jsonl"));
        this.size = 0;
      }
      appendFileSync(this.path, line, "utf8");
      this.size += Buffer.byteLength(line);
    } catch (e) {
      // Disque plein, fichier verrouillé : l'action continue, le problème est écrit dans le journal du noyau.
      console.error(`[audit] écriture impossible : ${e instanceof Error ? e.message : String(e)} ${line.trimEnd()}`);
    }
  }
  tail(n = 50): (AuditRecord & { t: string })[] {
    if (!existsSync(this.path)) return [];
    // Seulement la fin du fichier : un long journal n'est jamais lu en entier.
    const text = readEnd(this.path, Math.max(64 * 1024, n * 4096));
    const lines = text.trimEnd().split("\n").filter(Boolean);
    const out: (AuditRecord & { t: string })[] = [];
    for (const l of lines.slice(-n)) {
      try { out.push(JSON.parse(l)); } catch { /* ligne abîmée ou coupée par la lecture partielle : ignorée */ }
    }
    return out;
  }
}

function readEnd(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return len < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
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
