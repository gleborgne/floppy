// Corrections explicites, structurées : aucune substitution globale du texte reconnu.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { T, TextError } from "@floppy/core";
import type { MemoryCorrection, MemoryCorrectionInput, MemoryCorrectionQuery, MemoryOptions } from "@floppy/contracts";
import { storeOperation, type StoreMetrics, type StoreReporter } from "./store-audit.ts";

const text = (max: number) => z.string().min(1).max(max).refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s))
  .transform((s) => s.trim().replace(/\s+/gu, " ")).pipe(z.string().min(1).max(max));
const Scope = z.strictObject({ domain: text(100), account: text(512).optional(), container: text(512).optional() });
const Target = z.strictObject({ kind: text(100), id: text(1024), parentId: text(1024).optional() });
const Evidence = z.strictObject({ text: text(2000), session: text(512).optional() });
const Fields = { heard: text(256), canonical: text(256), scope: Scope, target: Target.optional(), evidence: Evidence };
const Input = z.strictObject({ ...Fields, replaces: z.strictObject({ id: z.uuid(), version: z.int().positive() }).optional() });
const Query = z.strictObject({ heard: text(256).optional(), scope: Scope.optional() });
const Stored = z.strictObject({ ...Fields, id: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), version: z.int().positive() });
const normalized = (s: string) => s.normalize("NFC").toLowerCase();
const scopeKey = (s: MemoryCorrection["scope"]) => JSON.stringify([s.domain, s.account ?? null, s.container ?? null]);
const targetKey = (t: MemoryCorrection["target"]) => JSON.stringify(t ? [t.kind, t.id, t.parentId ?? null] : null);

function invalid(): TextError {
  return new TextError(T("Correction invalide : vérifie les champs, leur taille et les caractères de contrôle.", "Invalid correction: check the fields, their size and control characters."));
}

/** Les mises à jour conditionnelles et les oublis sont atomiques, dans la base historique existante. */
export function correctionStore(db: DatabaseSync, report?: StoreReporter) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_corrections (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, heard_key TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE(scope_key, heard_key)
  )`);
  const all = db.prepare("SELECT data FROM memory_corrections ORDER BY id");
  const scoped = db.prepare("SELECT data FROM memory_corrections WHERE scope_key = ? ORDER BY id");
  const existing = db.prepare("SELECT data FROM memory_corrections WHERE scope_key = ? AND heard_key = ?");
  const insert = db.prepare("INSERT INTO memory_corrections (id, scope_key, heard_key, data) VALUES (?, ?, ?, ?)");
  const update = db.prepare("UPDATE memory_corrections SET data = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM memory_corrections WHERE id = ?");
  const count = db.prepare("SELECT count(*) AS n FROM memory_corrections");
  function decode(row: Record<string, unknown>): MemoryCorrection {
    try { return Stored.parse(JSON.parse(String(row.data))); }
    catch { throw new TextError(T("Une correction enregistrée est illisible ; aucune donnée n'a été modifiée.", "A saved correction cannot be read; no data was changed.")); }
  }
  function transaction<R>(run: () => R): R {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    corrections(query: MemoryCorrectionQuery = {}, options?: MemoryOptions): MemoryCorrection[] {
      return storeOperation(report, "correction.list", () => {
      options?.signal?.throwIfAborted();
      const parsed = Query.safeParse(query);
      if (!parsed.success) throw invalid();
      const q = parsed.data;
      const rows = q.scope ? scoped.all(scopeKey(q.scope)) : all.all();
      return rows.map(decode).filter((r) => q.heard === undefined || normalized(r.heard) === normalized(q.heard));
      }, (rows) => ({ count: rows.length, scopeFiltered: query.scope !== undefined, heardFiltered: query.heard !== undefined }), options);
    },
    saveCorrection(input: MemoryCorrectionInput, options?: MemoryOptions): MemoryCorrection {
      let outcome: StoreMetrics["outcome"] = "inserted";
      return storeOperation(report, "correction.save", () => {
      options?.signal?.throwIfAborted();
      const parsed = Input.safeParse(input);
      if (!parsed.success) throw invalid();
      const { replaces, ...fields } = parsed.data;
      return transaction(() => {
        const row = existing.get(scopeKey(fields.scope), normalized(fields.heard));
        const old = row ? decode(row) : undefined;
        if (replaces && (!old || replaces.id !== old.id || replaces.version !== old.version)) {
          throw new TextError(T("La correction a changé ou n'existe plus ; relis-la avant de la remplacer.", "The correction has changed or no longer exists; read it again before replacing it."));
        }
        if (old) {
          if (normalized(old.canonical) === normalized(fields.canonical) && targetKey(old.target) === targetKey(fields.target)) { outcome = "unchanged"; return old; }
          if (!replaces) throw new TextError(T("Une autre correction existe dans cette portée ; son remplacement explicite est nécessaire.", "Another correction exists in this scope; it must be explicitly replaced."));
          const next: MemoryCorrection = { ...fields, id: old.id, createdAt: old.createdAt, updatedAt: new Date().toISOString(), version: old.version + 1 };
          update.run(JSON.stringify(next), old.id);
          outcome = "updated";
          return next;
        }
        if (Number(count.get()!.n) >= 2000) throw new TextError(T("La mémoire des corrections est pleine ; oublie une correction avant d'en ajouter une.", "Correction memory is full; forget a correction before adding one."));
        const now = new Date().toISOString();
        const next: MemoryCorrection = { ...fields, id: randomUUID(), createdAt: now, updatedAt: now, version: 1 };
        insert.run(next.id, scopeKey(next.scope), normalized(next.heard), JSON.stringify(next));
        return next;
      });
      }, (row) => ({ count: outcome === "unchanged" ? 0 : 1, correctionId: row.id, version: row.version, outcome }), options);
    },
    forgetCorrection(id: string, options?: MemoryOptions): boolean {
      return storeOperation(report, "correction.delete", () => {
      options?.signal?.throwIfAborted();
      if (!z.uuid().safeParse(id).success) throw invalid();
      return transaction(() => Number(remove.run(id).changes) > 0);
      }, (removed) => ({ correctionId: id, count: removed ? 1 : 0, outcome: removed ? "deleted" : "missing" }), options);
    },
  };
}
