// Contrôles automatiques, format floppy-plugin.json, archives zip et sources (dossier, zip, git).
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { findExe, tr } from "@floppy/core";
import { checkPlugin, checkSource, hashDir, stripComments } from "../src/plugins/check.ts";
import { manifestMismatch, packageProblems, type PluginPackage } from "../src/plugins/format.ts";
import { readZip, safeZipPath } from "../src/plugins/zip.ts";
import { fetchSource, parseSource } from "../src/plugins/source.ts";

const tmp: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "floppy-check-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PKG: PluginPackage = { id: "essai", version: "1.0.0", licence: "MIT", api: 1 };
const OK_CODE = `import type { UserPlugin } from "./floppy-plugin.d.ts";\nconst p: UserPlugin = { manifest: { id: "essai", version: "1.0.0", licence: "MIT" }, apply() {} };\nexport default p;\n`;

function plugin(files: Record<string, string | Buffer>, pkg: Partial<PluginPackage> | null = {}): string {
  const dir = join(temp(), "essai");
  mkdirSync(dir);
  if (pkg) writeFileSync(join(dir, "floppy-plugin.json"), JSON.stringify({ ...PKG, ...pkg }));
  for (const [p, c] of Object.entries({ "index.ts": OK_CODE, ...files })) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const codes = (src: string, pkg: PluginPackage = PKG) => checkSource("index.ts", src, pkg).filter((f) => f.severity === "block").map((f) => f.code);

/** Petite archive zip (deflate), pour les essais. */
function makeZip(entries: { name: string; data: string | Buffer; method?: 0 | 8; attr?: number }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((e.attr ?? 0) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("format floppy-plugin.json", () => {
  it("refuse fichiers, programmes, accords et une api inconnue", () => {
    expect(packageProblems(PKG)).toEqual([]);
    expect(packageProblems({ ...PKG, api: 2 }).map((t) => tr(t))[0]).toContain("api");
    for (const k of ["fs.read", "fs.write", "exec"]) expect(packageProblems({ ...PKG, permissions: { [k]: ["x"] } }).length).toBe(1);
    expect(packageProblems({ ...PKG, permissions: { approvals: "respond" } }).length).toBe(1);
    expect(packageProblems({ ...PKG, homepage: "http://x" }).length).toBe(1);
    expect(packageProblems({ ...PKG, homepage: "https://x.example" })).toEqual([]); // api et homepage sont des champs du paquet, pas des fautes
    expect(packageProblems({ ...PKG, permisions: { net: ["a.com"] } }).map((t) => tr(t, "en"))).toEqual(["invalid manifest: permisions : unknown field (did you mean \"permissions\"?)"]);
  });

  it("le manifeste du code doit correspondre au fichier JSON", () => {
    const m = { id: "essai", version: "1.0.0", licence: "MIT" };
    expect(manifestMismatch(PKG, m)).toBeUndefined();
    expect(manifestMismatch({ ...PKG, permissions: { net: ["a.com"] } }, { ...m, permissions: { net: ["a.com"] } })).toBeUndefined();
    expect(manifestMismatch(PKG, { ...m, permissions: { net: ["a.com"] } })).toBeDefined();
    expect(manifestMismatch(PKG, { ...m, version: "2" })).toBeDefined();
    expect(manifestMismatch(PKG, { ...m, provides: ["llm"] })).toBeDefined();
  });
});

describe("contrôles du code", () => {
  it("un plugin propre passe ; les types importés sont permis", () => {
    const dir = plugin({ "util.ts": "export const x = 1;\n", "README.md": "# essai", "icone.png": Buffer.from([1, 2, 3]) });
    const r = checkPlugin(dir);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDir(dir)).toBe(r.hash);
    expect(codes(`import { x } from "./util.ts";\nimport type { A } from "@floppy/core";\n`)).toEqual([]);
  });

  it("bloque les imports, modules Node et constructions de code", () => {
    expect(codes(`import { readFileSync } from "node:fs";`)).toContain("import");
    expect(codes(`import { z } from "zod";`)).toContain("import");
    expect(codes(`import { type A } from "zod";`)).toContain("import"); // type en ligne : le module est quand même chargé
    expect(codes(`import "./side.js";`)).toContain("import");
    expect(codes(`import { x } from "../ailleurs/x.ts";`)).toContain("import");
    expect(codes(`const m = await import("x");`)).toContain("dynamic-import");
    expect(codes(`const fs = require("fs");`)).toContain("require");
    expect(codes(`eval("1")`)).toContain("eval");
    expect(codes(`new Function("return 1")`)).toContain("eval");
    expect(codes(`process.getBuiltinModule("fs")`)).toContain("process-api");
    expect(codes(`process["binding"]("fs")`)).toContain("process-api");
    expect(codes(`globalThis["ev" + "al"]`)).toContain("escape");
    expect(codes(`const x = "child_process";`)).toContain("node-module");
    expect(codes(`new WebSocket("wss://x")`)).toContain("socket");
  });

  it("réseau : fetch sans permissions.net est bloqué", () => {
    expect(codes(`await fetch("https://a.com")`)).toContain("net");
    expect(codes(`await fetch("https://a.com")`, { ...PKG, permissions: { net: ["a.com"] } })).toEqual([]);
  });

  it("les commentaires ne déclenchent rien ; les chaînes avec // restent", () => {
    expect(codes(`// eval("x") require("y")\n/* import("z") */\nconst u = "https://a.com/x";\n`)).toEqual([]);
    expect(stripComments(`a // b\nc /* d\ne */ f "g // h"`)).toBe(`a \nc \n f "g // h"`);
  });

  it("bloque code minifié, caractères invisibles ; signale les chaînes codées", () => {
    expect(codes("const a = 1;" + " ".repeat(1200))).toContain("minified");
    expect(codes("const a = 1; // \u202E retourné")).toContain("invisible");
    const warn = checkSource("index.ts", `const b = "${"QUJD".repeat(150)}";`, PKG);
    expect(warn.some((f) => f.code === "blob" && f.severity === "warn")).toBe(true);
  });

  it("bloque fichiers interdits, dossiers, paquets npm et tailles", () => {
    const r = checkPlugin(plugin({ "outil.exe": "MZ", "lib.js": "x", "node_modules/a/i.js": "x", "package.json": JSON.stringify({ scripts: { postinstall: "x" } }) }));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code).sort()).toEqual(["file-type", "file-type", "folder", "npm"]);
    expect(checkPlugin(plugin({}, null)).findings.map((f) => f.code)).toContain("package");
    expect(checkPlugin(plugin({ "gros.ts": "//" + "x".repeat(210_000) })).findings.map((f) => f.code)).toContain("size");
  });
});

describe("archives zip", () => {
  it("lit stocké et deflate, retire le dossier commun du haut", () => {
    const files = readZip(makeZip([{ name: "depot-main/", data: "" }, { name: "depot-main/index.ts", data: "abc" }, { name: "depot-main/a/b.md", data: "x".repeat(1000), method: 0 }]));
    expect(files.map((f) => [f.path, f.data.length])).toEqual([["index.ts", 3], ["a/b.md", 1000]]);
  });

  it("refuse chemins qui sortent, liens et bombes", () => {
    expect(safeZipPath("../x")).toBeUndefined();
    expect(safeZipPath("C:/x")).toBeUndefined();
    expect(safeZipPath("/etc/x")).toBeUndefined();
    expect(safeZipPath("a/./b")).toBe("a/b");
    expect(() => readZip(makeZip([{ name: "../evil.ts", data: "x" }]))).toThrow();
    expect(() => readZip(makeZip([{ name: "lien", data: "/etc/passwd", attr: 0o120777 << 16 }]))).toThrow();
    expect(() => readZip(makeZip([{ name: "bombe.txt", data: "0".repeat(2_000_000) }]))).toThrow();
    expect(() => readZip(Buffer.from("pas un zip"))).toThrow();
  });
});

describe("sources", () => {
  it("reconnaît dossier, zip, adresse zip et git", () => {
    const d = temp();
    expect(parseSource(d).kind).toBe("dir");
    expect(parseSource("https://contoso.example/p.zip").kind).toBe("zip-url");
    expect(parseSource("https://contoso.example/depot.git#v1.2")).toEqual({ kind: "git", location: "https://contoso.example/depot.git", ref: "v1.2" });
    expect(parseSource("git+file:///C:/depot").kind).toBe("git");
    expect(() => parseSource("http://contoso.example/p.zip")).toThrow();
    expect(() => parseSource("https://moi:secret@contoso.example/x.git")).toThrow();
    expect(() => parseSource("https://contoso.example/x.git#a;rm")).toThrow();
  });

  it("copie un dossier sans .git ni node_modules ; extrait un zip (fichier ou adresse)", async () => {
    const src = plugin({ ".git/HEAD": "x", "node_modules/a.ts": "x" });
    const out = join(temp(), "o");
    await fetchSource(src, out);
    expect(existsSync(join(out, "index.ts"))).toBe(true);
    expect(existsSync(join(out, ".git"))).toBe(false);
    expect(existsSync(join(out, "node_modules"))).toBe(false);

    const zip = join(temp(), "p.zip");
    writeFileSync(zip, makeZip([{ name: "p/index.ts", data: OK_CODE }, { name: "p/floppy-plugin.json", data: JSON.stringify(PKG) }]));
    const out2 = join(temp(), "o");
    await fetchSource(zip, out2);
    expect(checkPlugin(out2).ok).toBe(true);

    const out3 = join(temp(), "o");
    const f = (async () => new Response(readFileSync(zip))) as unknown as typeof fetch;
    expect(await fetchSource("https://contoso.example/p.zip", out3, { fetch: f })).toEqual({ kind: "zip-url", source: "https://contoso.example/p.zip" });
    expect(existsSync(join(out3, "index.ts"))).toBe(true);
  });

  it.skipIf(!findExe("git"))("clone un dépôt git à un commit précis, sans l'historique", async () => {
    const repo = plugin({});
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@contoso.example", ...a], { encoding: "utf8" }).trim();
    git("init", "-q"); git("add", "."); git("commit", "-qm", "v1");
    const v1 = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "v2"); git("add", "."); git("commit", "-qm", "v2");
    const out = join(temp(), "o");
    const r = await fetchSource(`git+file:///${repo.replaceAll("\\", "/")}#${v1}`, out);
    expect(r.commit).toBe(v1);
    expect(existsSync(join(out, "README.md"))).toBe(false);
    expect(existsSync(join(out, ".git"))).toBe(false);
  }, 30_000);
});
