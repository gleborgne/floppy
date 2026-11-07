// Modèles déjà sur la machine (LM Studio, Ollama, dossiers de l'utilisateur) : ce sont des fichiers GGUF que
// llama.cpp lance tels quels. Rien à télécharger, et LM Studio ou Ollama n'ont pas besoin de tourner.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { scanGguf } from "@floppy/core";

export interface FoundModel {
  /** Id stable (d'où il vient + son nom). */
  id: string;
  label: string;
  file: string;
  size: number;
  from: "lmstudio" | "ollama";
}

export { scanGguf };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const sizeOf = (f: string): number => { try { return statSync(f).size; } catch { return 0; } };

/** Le fichier commence-t-il par « GGUF » ? (un blob d'Ollama peut être autre chose, ou abîmé) */
export function isGguf(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 0) === 4 && b.toString("latin1") === "GGUF";
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Fichiers GGUF des dossiers (LM Studio, réglage « dossiers »). Un modèle en plusieurs morceaux compte une fois
 * (par son premier morceau, celui que llama-server ouvre).
 */
export function scanFolders(dirs: string[]): FoundModel[] {
  const out: FoundModel[] = [];
  for (const file of scanGguf(dirs)) {
    const part = file.match(/-(\d{5})-of-\d{5}\.gguf$/i);
    if (part && part[1] !== "00001") continue;
    const root = dirs.find((d) => file.startsWith(d + sep) || file.startsWith(d + "/")) ?? "";
    const name = basename(file).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, "");
    out.push({ id: `lmstudio-${slug(root ? relative(root, file) : name)}`, label: name, file, size: sizeOf(file), from: "lmstudio" });
  }
  return out;
}

/** Dossier des modèles d'Ollama (OLLAMA_MODELS, sinon celui par défaut). */
export function ollamaDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.OLLAMA_MODELS?.trim() || join(home, ".ollama", "models");
}

/**
 * Modèles d'Ollama. Chaque manifeste (manifests/<hôte>/<espace>/<nom>/<étiquette>) donne la couche « model » :
 * un fichier GGUF rangé dans blobs/sha256-<empreinte>.
 */
export function scanOllama(dir: string): FoundModel[] {
  const base = join(dir, "manifests");
  const out: FoundModel[] = [];
  const walk = (d: string, parts: string[]) => {
    if (parts.length > 5 || out.length >= 60) return;
    let names: Dirent[];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p, [...parts, e.name]); continue; }
      const m = readManifest(p);
      if (!m) continue;
      const blob = join(dir, "blobs", m.digest.replace(":", "-"));
      if (!isGguf(blob)) continue;
      const [host, space, name] = parts;
      const tag = e.name;
      // « llama3.2:3b » pour la bibliothèque d'Ollama ; « espace/nom:étiquette » sinon (ex. hf.co/…).
      const label = host === "registry.ollama.ai" && space === "library" ? `${name}:${tag}` : `${[space, name].filter(Boolean).join("/")}:${tag}`;
      out.push({ id: `ollama-${slug(label)}`, label, file: blob, size: m.size || sizeOf(blob), from: "ollama" });
    }
  };
  walk(base, []);
  return out;
}

function readManifest(file: string): { digest: string; size: number } | undefined {
  try {
    if (statSync(file).size > 1_000_000) return undefined;
    const j = JSON.parse(readFileSync(file, "utf8")) as { layers?: { mediaType?: string; digest?: string; size?: number }[] };
    const l = j.layers?.find((x) => x.mediaType === "application/vnd.ollama.image.model");
    return l?.digest && /^sha256:[a-f0-9]{64}$/.test(l.digest) ? { digest: l.digest, size: Number(l.size) || 0 } : undefined;
  } catch { return undefined; }
}
