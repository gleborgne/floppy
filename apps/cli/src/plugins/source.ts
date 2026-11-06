// D'où vient un plugin tiers : un dossier, une archive zip (fichier ou adresse), ou un dépôt git.
// Le contenu est seulement copié dans un dossier : rien n'est exécuté (ni script, ni hook git, ni sous-module).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findExe, T, TextError } from "@floppy/core";
import { DEFAULT_ZIP_LIMITS, readZip } from "./zip.ts";

export type SourceKind = "dir" | "zip" | "zip-url" | "git";

export interface ParsedSource {
  kind: SourceKind;
  /** Chemin local ou adresse. */
  location: string;
  /** Branche, étiquette ou commit (git), après « # ». */
  ref?: string;
}

export interface FetchedSource {
  kind: SourceKind;
  /** Source telle que gardée dans le verrou (sans identifiants). */
  source: string;
  ref?: string;
  /** Commit exact récupéré (git). */
  commit?: string;
}

const REF_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

export function parseSource(input: string): ParsedSource {
  const s = input.trim();
  if (!s) throw new TextError(T("source vide", "empty source"));
  const [base, ref] = s.split("#", 2) as [string, string | undefined];
  if (ref !== undefined && !REF_RE.test(ref)) throw new TextError(T(`référence git invalide : ${ref}`, `invalid git reference: ${ref}`));
  if (/^git\+(https|file):\/\//i.test(base)) return { kind: "git", location: base.slice(4), ...(ref ? { ref } : {}) };
  if (/^https:\/\//i.test(base)) {
    const u = new URL(base);
    if (u.username || u.password) throw new TextError(T("pas d'identifiants dans l'adresse", "no credentials in the address"));
    if (/\.zip$/i.test(u.pathname)) return { kind: "zip-url", location: base };
    return { kind: "git", location: base, ...(ref ? { ref } : {}) };
  }
  if (/^[a-z]+:\/\//i.test(base)) throw new TextError(T("seules les adresses https:// sont acceptées", "only https:// addresses are accepted"));
  const p = resolve(base);
  if (!existsSync(p)) throw new TextError(T(`introuvable : ${p}`, `not found: ${p}`));
  if (statSync(p).isDirectory()) return { kind: "dir", location: p };
  if (/\.zip$/i.test(p)) return { kind: "zip", location: p };
  throw new TextError(T("source non reconnue : un dossier, un .zip, une adresse https://…zip ou un dépôt git", "unknown source: a folder, a .zip, an https://…zip address or a git repository"));
}

function writeFiles(dest: string, files: { path: string; data: Buffer }[]): void {
  for (const f of files) {
    const to = join(dest, f.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.data);
  }
}

function run(exe: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((ok, ko) => {
    const p = spawn(exe, args, {
      cwd, windowsHide: true,
      // Aucune question (identifiants), aucun filtre (LFS), aucun éditeur.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_LFS_SKIP_SMUDGE: "1" },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); ko(e); });
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? ok(out.trim()) : ko(new Error(err.trim().slice(-400) || `code ${code}`)); });
  });
}

export interface FetchOptions {
  git?: string;
  fetch?: typeof fetch;
  maxBytes?: number;
}

/** Récupère la source dans `dest` (dossier vide ou absent). */
export async function fetchSource(input: string, dest: string, opts: FetchOptions = {}): Promise<FetchedSource> {
  const src = parseSource(input);
  mkdirSync(dest, { recursive: true });
  switch (src.kind) {
    case "dir": {
      cpSync(src.location, dest, {
        recursive: true,
        filter: (from) => !/[\\/](\.git|node_modules|\.floppy-dev)([\\/]|$)/.test(from.slice(src.location.length)),
      });
      return { kind: "dir", source: src.location };
    }
    case "zip": {
      writeFiles(dest, readZip(readFileSync(src.location)));
      return { kind: "zip", source: src.location };
    }
    case "zip-url": {
      const max = opts.maxBytes ?? DEFAULT_ZIP_LIMITS.maxTotal;
      const r = await (opts.fetch ?? fetch)(src.location, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new TextError(T(`téléchargement refusé (HTTP ${r.status})`, `download refused (HTTP ${r.status})`));
      if (Number(r.headers.get("content-length") ?? 0) > max) throw new TextError(T("archive trop grosse", "archive too large"));
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw new TextError(T("archive trop grosse", "archive too large"));
      writeFiles(dest, readZip(buf));
      return { kind: "zip-url", source: src.location };
    }
    case "git": {
      const git = opts.git ?? findExe("git");
      if (!git) throw new TextError(T("git est introuvable : installe-le ou donne une archive .zip", "git was not found: install it or give a .zip archive"));
      try {
        // init + fetch d'un seul commit : marche pour une branche, une étiquette ou un commit, sans historique.
        await run(git, ["init", "-q", dest]);
        await run(git, ["-c", "protocol.file.allow=always", "fetch", "-q", "--depth", "1", "--no-tags", src.location, src.ref ?? "HEAD"], dest);
        await run(git, ["-c", "core.hooksPath=", "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], dest);
        const commit = await run(git, ["rev-parse", "HEAD"], dest);
        rmSync(join(dest, ".git"), { recursive: true, force: true });
        return { kind: "git", source: src.location, ...(src.ref ? { ref: src.ref } : {}), commit };
      } catch (e) {
        if (e instanceof TextError) throw e;
        throw new TextError(T(`git : ${(e as Error).message}`, `git: ${(e as Error).message}`));
      }
    }
  }
}
