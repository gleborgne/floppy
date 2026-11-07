// Fichiers de l'utilisateur : écriture atomique, fichier abîmé mis de côté (jamais remis à zéro en silence).
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItemStore, readJsonFile, writeJsonAtomic, onCorruptFile, corruptFiles, Kernel, definePlugin } from "../src/index.ts";

beforeEach(() => { onCorruptFile(() => {}); });

describe("fichiers de l'utilisateur", () => {
  it("écrit sans laisser de fichier temporaire", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-files-"));
    const f = join(dir, "sous", "a.json");
    writeJsonAtomic(f, { a: 1 });
    writeJsonAtomic(f, { a: 2 });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "sous"))).toEqual(["a.json"]);
  });

  it("met de côté un fichier illisible et le signale", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-files-"));
    const f = join(dir, "b.json");
    writeFileSync(f, "{ cassé", "utf8");
    const seen: string[] = [];
    onCorruptFile((file) => seen.push(file));
    expect(readJsonFile(f)).toBeUndefined();
    expect(seen).toEqual([f]);
    expect(existsSync(f)).toBe(false);
    const moved = readdirSync(dir).find((n) => n.startsWith("b.json.corrupt-"));
    expect(moved && readFileSync(join(dir, moved), "utf8")).toBe("{ cassé");
    expect(corruptFiles().some((c) => c.file === f)).toBe(true);
  });

  it("un fichier impossible à lire (pas abîmé) lève une erreur : jamais remis à zéro en silence", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-files-"));
    const f = join(dir, "settings.json");
    mkdirSync(f); // un dossier à cet endroit : la lecture échoue à chaque essai, comme un fichier tenu
    const seen: string[] = [];
    onCorruptFile((file) => seen.push(file));
    expect(() => readJsonFile(f)).toThrow(/lecture impossible/);
    expect(seen).toEqual([]);
    expect(existsSync(f)).toBe(true);
  });

  it("absent ou vide : rien à signaler", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-files-"));
    const seen: string[] = [];
    onCorruptFile((file) => seen.push(file));
    expect(readJsonFile(join(dir, "absent.json"))).toBeUndefined();
    writeFileSync(join(dir, "vide.json"), "", "utf8");
    expect(readJsonFile(join(dir, "vide.json"))).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("des éléments abîmés : la sauvegarde suivante n'efface pas l'original", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-files-"));
    const f = join(dir, "items.json");
    writeFileSync(f, "{\"added\": {", "utf8");
    const s = new ItemStore(f);
    s.setEnabled("x", false);
    expect(readdirSync(dir).some((n) => n.startsWith("items.json.corrupt-"))).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8")).disabled).toEqual(["x"]);
  });

  it("des réglages abîmés : le noyau démarre et garde une copie", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-files-"));
    writeFileSync(join(home, "settings.json"), "{ \"voix\": ", "utf8");
    const k = new Kernel({ logger: () => {}, home, plugins: [definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply() {} })] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(k.status().find((s) => s.id === "p")?.state).toBe("active");
    expect(readdirSync(home).some((n) => n.startsWith("settings.json.corrupt-"))).toBe(true);
    await k.stopAll();
  });
});
