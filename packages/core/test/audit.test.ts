// Journal d'audit : borné en taille, lu par la fin, et une écriture impossible ne fait pas échouer l'action.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAudit } from "../src/index.ts";

describe("journal d'audit", () => {
  it("passe à un nouveau fichier au-delà de la taille fixée", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-audit-"));
    const a = new FileAudit(join(dir, "audit.jsonl"), { maxBytes: 300 });
    for (let i = 0; i < 10; i++) a.write({ kind: "tool", n: i, pad: "x".repeat(40) });
    expect(existsSync(join(dir, "audit.1.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8").length).toBeLessThanOrEqual(300);
    expect(a.tail(1)[0]).toMatchObject({ kind: "tool", n: 9 });
  });

  it("lit seulement la fin d'un long journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-audit-"));
    const a = new FileAudit(join(dir, "audit.jsonl"));
    for (let i = 0; i < 2000; i++) a.write({ kind: "tool", n: i, pad: "y".repeat(100) });
    expect(a.tail(3).map((r) => r.n)).toEqual([1997, 1998, 1999]);
  });

  it("une écriture impossible ne lève pas d'erreur", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-audit-"));
    const f = join(dir, "audit.jsonl");
    mkdirSync(f); // un dossier à la place du fichier : l'écriture échoue
    const a = new FileAudit(f);
    const err = console.error;
    console.error = () => {};
    try { expect(() => a.write({ kind: "tool" })).not.toThrow(); } finally { console.error = err; }
  });
});
