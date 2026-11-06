// Contrôles automatiques d'un plugin tiers, AVANT toute exécution et avant la revue par l'IA.
// Ils lisent le texte des fichiers, sans rien exécuter. Un modèle ne peut pas les contourner (pas d'injection de prompt).
// Ce sont aussi ceux de `floppy plugin check` : l'auteur voit ce que verra la personne qui installe.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { T, tr, type Text } from "@floppy/core";
import { PACKAGE_FILE, packageProblems, type PluginPackage } from "./format.ts";

export type Severity = "block" | "warn" | "info";

export interface Finding {
  severity: Severity;
  /** Code stable (tests, documentation). */
  code: string;
  file?: string;
  line?: number;
  message: Text;
}

export interface PluginFile { path: string; size: number }

export interface CheckReport {
  pkg?: PluginPackage;
  files: PluginFile[];
  /** Empreinte sha256 du contenu (chemins + octets) : la revue et l'accord portent sur CE contenu. */
  hash: string;
  findings: Finding[];
  /** Aucun problème bloquant. */
  ok: boolean;
}

export const LIMITS = { files: 200, total: 512_000, file: 200_000, line: 1000, literal: 400 };

const TEXT_EXT = new Set([".ts", ".md", ".json", ".txt"]);
const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const PLAIN_NAMES = /^(license|licence|notice|readme|changelog|\.gitignore|\.gitattributes|\.editorconfig)(\.[a-z]+)?$/i;

/** Liste les fichiers (chemins relatifs « / »), sans suivre les liens. */
export function listFiles(dir: string): { files: PluginFile[]; findings: Finding[] } {
  const files: PluginFile[] = [];
  const findings: Finding[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(abs, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { findings.push({ severity: "block", code: "symlink", file: r, message: T("lien symbolique refusé", "symbolic link refused") }); continue; }
      if (st.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") {
          findings.push({ severity: "block", code: "folder", file: r, message: T(`dossier « ${e.name} » refusé`, `"${e.name}" folder refused`) });
          continue;
        }
        if (e.name === ".floppy-dev") continue; // données du mode debug de l'auteur
        walk(p, r);
      } else if (st.isFile()) files.push({ path: r, size: st.size });
      if (files.length > LIMITS.files) return;
    }
  };
  walk(dir, "");
  return { files, findings };
}

/** sha256 de (chemin, contenu) de chaque fichier, dans l'ordre des chemins. */
export function hashFiles(dir: string, files: PluginFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update("\0").update(readFileSync(join(dir, f.path))).update("\0");
  }
  return h.digest("hex");
}

/** Empreinte d'un dossier de plugin (mêmes règles que checkPlugin). */
export function hashDir(dir: string): string {
  return hashFiles(dir, listFiles(dir).files);
}

/** Retire les commentaires (pas les chaînes) en gardant les retours à la ligne : les numéros de ligne restent justes. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) quote = undefined;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Motifs refusés dans le code (après retrait des commentaires). */
const BLOCKED: { re: RegExp; code: string; fr: string; en: string }[] = [
  { re: /\brequire\s*\(/g, code: "require", fr: "require() : aucun module ne peut être chargé à l'exécution", en: "require(): no module can be loaded at run time" },
  { re: /\bimport\s*\(/g, code: "dynamic-import", fr: "import() dynamique refusé", en: "dynamic import() refused" },
  { re: /\bprocess\s*\.\s*(getBuiltinModule|binding|_linkedBinding|dlopen|kill)\b/g, code: "process-api", fr: "accès interne au processus refusé", en: "internal process access refused" },
  { re: /\bprocess\s*\[/g, code: "process-api", fr: "accès calculé à process refusé", en: "computed access to process refused" },
  { re: /\beval\s*\(/g, code: "eval", fr: "eval() refusé", en: "eval() refused" },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/g, code: "eval", fr: "construction de code (Function) refusée", en: "code construction (Function) refused" },
  { re: /\bWebAssembly\b/g, code: "wasm", fr: "WebAssembly refusé", en: "WebAssembly refused" },
  { re: /\bglobalThis\s*\[|\bconstructor\s*\.\s*constructor\b/g, code: "escape", fr: "accès calculé aux objets globaux refusé", en: "computed access to globals refused" },
  { re: /child_process|node:|worker_threads/g, code: "node-module", fr: "module système de Node refusé", en: "Node system module refused" },
];

const NET_RE = /\bfetch\s*\(|\bWebSocket\b|\bEventSource\b/g;
const WARNED: { re: RegExp; code: string; fr: string; en: string }[] = [
  { re: /\bprocess\s*\.\s*env\b/g, code: "env", fr: "lit les variables d'environnement (vides dans le processus isolé)", en: "reads environment variables (empty in the isolated process)" },
  { re: /\batob\s*\(|\bBuffer\s*\.\s*from\s*\([^)]*base64/g, code: "decode", fr: "décode du base64 : vérifier ce qui est décodé", en: "decodes base64: check what is decoded" },
];
// Caractères invisibles ou de sens d'écriture (« trojan source ») : le code lu n'est pas le code exécuté.
const INVISIBLE_RE = /[​-‍‪-‮⁦-⁩﻿]/g;

/** Vérifie un fichier .ts. */
export function checkSource(path: string, src: string, pkg: PluginPackage | undefined): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, code: string, index: number, message: Text, text = src): void => {
    out.push({ severity, code, file: path, line: lineOf(text, index), message });
  };
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (const m of src.slice(bom).matchAll(INVISIBLE_RE)) add("block", "invisible", m.index + bom, T("caractère invisible ou de sens d'écriture", "invisible or bidirectional character"));
  src.split("\n").forEach((l, i) => {
    if (l.length > LIMITS.line) out.push({ severity: "block", code: "minified", file: path, line: i + 1, message: T(`ligne de ${l.length} caractères : code minifié ou masqué`, `${l.length}-character line: minified or hidden code`) });
  });
  const code = stripComments(src);
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (m[2]!.length > LIMITS.literal && /^[A-Za-z0-9+/=_-]+$/.test(m[2]!)) {
      add("warn", "blob", m.index, T("longue chaîne codée (base64 ou hexadécimal)", "long encoded string (base64 or hex)"), code);
    }
  }
  // Imports : seuls `import type` (effacés) et les fichiers .ts du plugin lui-même.
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([^;'"`]*?)\bfrom\s*(["'])([^"']+)\4/g)) {
    if (m[2] || !/^(import|export)$/.test(m[1]!)) continue;
    checkSpecifier(m[5]!, m.index);
  }
  for (const m of code.matchAll(/\bimport\s*(["'])([^"']+)\1/g)) checkSpecifier(m[2]!, m.index);
  function checkSpecifier(spec: string, index: number): void {
    const local = (spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".ts") && !spec.endsWith(".d.ts");
    const inside = local && !posix.normalize(posix.join(posix.dirname(path), spec)).startsWith("..");
    if (!inside) add("block", "import", index, T(`import « ${spec} » refusé : seuls « import type » et les fichiers .ts du plugin sont permis`, `import "${spec}" refused: only "import type" and the plugin's own .ts files are allowed`), code);
  }
  for (const b of BLOCKED) for (const m of code.matchAll(b.re)) add("block", b.code, m.index, T(b.fr, b.en), code);
  for (const w of WARNED) for (const m of code.matchAll(w.re)) add("warn", w.code, m.index, T(w.fr, w.en), code);
  const net = pkg?.permissions?.net ?? [];
  for (const m of code.matchAll(NET_RE)) {
    if (/WebSocket|EventSource/.test(m[0])) add("block", "socket", m.index, T("WebSocket et EventSource ne sont pas disponibles : utiliser fetch", "WebSocket and EventSource are not available: use fetch"), code);
    else if (!net.length) add("block", "net", m.index, T("accès réseau sans permissions.net", "network access without permissions.net"), code);
  }
  return out;
}

/** Contrôle complet d'un dossier. Ne lève pas : tout problème devient un constat. */
export function checkPlugin(dir: string): CheckReport {
  const findings: Finding[] = [];
  let files: PluginFile[] = [];
  try {
    const l = listFiles(dir);
    files = l.files;
    findings.push(...l.findings);
  } catch (e) {
    return { files: [], hash: "", ok: false, findings: [{ severity: "block", code: "read", message: T(`dossier illisible : ${(e as Error).message}`, `folder cannot be read: ${(e as Error).message}`) }] };
  }

  let pkg: PluginPackage | undefined;
  const pkgFile = files.find((f) => f.path === PACKAGE_FILE);
  if (!pkgFile) findings.push({ severity: "block", code: "package", message: T(`${PACKAGE_FILE} manquant`, `${PACKAGE_FILE} is missing`) });
  else {
    try {
      const raw = JSON.parse(readFileSync(join(dir, PACKAGE_FILE), "utf8"));
      const problems = packageProblems(raw);
      for (const p of problems) findings.push({ severity: "block", code: "package", file: PACKAGE_FILE, message: p });
      if (!problems.length) pkg = raw as PluginPackage;
    } catch (e) {
      findings.push({ severity: "block", code: "package", file: PACKAGE_FILE, message: T(`JSON invalide : ${(e as Error).message}`, `invalid JSON: ${(e as Error).message}`) });
    }
  }
  if (!files.some((f) => f.path === "index.ts")) findings.push({ severity: "block", code: "index", message: T("index.ts manquant", "index.ts is missing") });

  if (files.length > LIMITS.files) findings.push({ severity: "block", code: "size", message: T(`plus de ${LIMITS.files} fichiers`, `more than ${LIMITS.files} files`) });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > LIMITS.total) findings.push({ severity: "block", code: "size", message: T(`contenu trop gros (${Math.round(total / 1000)} Ko, maximum ${LIMITS.total / 1000} Ko)`, `content too large (${Math.round(total / 1000)} KB, maximum ${LIMITS.total / 1000} KB)`) });

  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    const base = f.path.split("/").pop()!;
    if (f.size > LIMITS.file) { findings.push({ severity: "block", code: "size", file: f.path, message: T("fichier trop gros", "file too large") }); continue; }
    if (base === "package.json") {
      try {
        const pj = JSON.parse(readFileSync(join(dir, f.path), "utf8")) as Record<string, unknown>;
        for (const k of ["scripts", "dependencies", "optionalDependencies", "peerDependencies", "bin"]) {
          if (pj[k] && Object.keys(pj[k] as object).length) findings.push({ severity: "block", code: "npm", file: f.path, message: T(`package.json : « ${k} » refusé (aucun paquet npm, aucun script)`, `package.json: "${k}" refused (no npm packages, no scripts)`) });
        }
      } catch { findings.push({ severity: "block", code: "npm", file: f.path, message: T("package.json illisible", "package.json cannot be read") }); }
      continue;
    }
    if (ASSET_EXT.has(ext) || PLAIN_NAMES.test(base)) continue;
    if (!TEXT_EXT.has(ext)) {
      findings.push({ severity: "block", code: "file-type", file: f.path, message: T(`type de fichier refusé (${ext || "sans extension"}) : seulement du TypeScript, du texte et des images`, `file type refused (${ext || "no extension"}): only TypeScript, text and images`) });
      continue;
    }
    if (ext === ".ts" && !f.path.endsWith(".d.ts")) findings.push(...checkSource(f.path, readFileSync(join(dir, f.path), "utf8"), pkg));
  }

  let hash = "";
  try { hash = hashFiles(dir, files); } catch { /* fichier disparu : signalé plus haut */ }
  return { ...(pkg ? { pkg } : {}), files, hash, findings, ok: !findings.some((f) => f.severity === "block") };
}

/** Constats en lignes de texte, les plus graves d'abord. */
export function formatFindings(findings: Finding[], lang = "fr"): string[] {
  const order: Record<Severity, number> = { block: 0, warn: 1, info: 2 };
  const label: Record<Severity, [string, string]> = { block: ["BLOQUANT", "BLOCKING"], warn: ["attention", "warning"], info: ["info", "info"] };
  return [...findings].sort((a, b) => order[a.severity] - order[b.severity]).map((f) => {
    const where = f.file ? `${f.file}${f.line ? ":" + f.line : ""} ` : "";
    const msg = tr(f.message, lang);
    return `[${label[f.severity][lang === "en" ? 1 : 0]}] ${where}${msg}`;
  });
}
