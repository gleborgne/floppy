// Le répertoire de travail de Floppy : un seul dossier pour la config (floppy.yml), les réglages, les modèles, les
// espaces de travail des agents, les plugins tiers et les journaux.
// - Par défaut : %LOCALAPPDATA%\floppy (ailleurs : $XDG_DATA_HOME/floppy, sinon ~/.local/share/floppy).
// - L'utilisateur peut en choisir un autre (fenêtre « Bienvenue », réglages, CLI). Le choix est noté dans un petit
//   fichier « pointeur » qui reste toujours au même endroit : <dossier par défaut>/home.json.
// - Changer de dossier : les données suivent (déplacées au démarrage suivant, quand plus rien n'est ouvert), sauf si
//   le nouveau dossier contient déjà des données de Floppy : il est alors utilisé tel quel.
// - FLOPPY_HOME (tests, mode debug, --home) passe avant tout.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./files.ts";
import { T, TextError } from "../i18n.ts";

const POINTER = "home.json";
/** Fichiers qui montrent qu'un dossier contient déjà des données de Floppy. */
const MARKERS = ["settings.json", "floppy.yml", "items", "audit.jsonl"];

interface Pointer {
  /** Dossier choisi. */
  home?: string;
  /** Déplacement à faire au prochain démarrage : depuis ce dossier vers `home`. */
  moveFrom?: string;
}

/** Dossier de données par défaut du système (là où vit le pointeur). */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "floppy");
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "floppy");
}

const pointerFile = (env: NodeJS.ProcessEnv = process.env) => join(defaultHome(env), POINTER);

function readPointer(env: NodeJS.ProcessEnv = process.env): Pointer {
  const p = readJsonFile<Pointer>(pointerFile(env));
  return p && typeof p === "object" ? p : {};
}

/** Le répertoire de travail en usage (créé s'il manque). */
export function floppyHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLOPPY_HOME) { mkdirSync(env.FLOPPY_HOME, { recursive: true }); return env.FLOPPY_HOME; }
  const chosen = readPointer(env).home;
  if (chosen && isAbsolute(chosen)) {
    try { mkdirSync(chosen, { recursive: true }); return chosen; } catch { /* disque absent (clé USB débranchée) : dossier par défaut */ }
  }
  const base = defaultHome(env);
  // Ancien nom du dossier de données (avant le renommage du projet) : déplacé une fois.
  const legacy = join(base, "..", "assistant");
  if (!existsSync(base) && existsSync(legacy)) {
    try { renameSync(legacy, base); } catch { return legacy; /* dossier occupé (ancienne app ouverte) : nouvel essai au prochain démarrage */ }
  }
  mkdirSync(base, { recursive: true });
  return base;
}

/** Le dossier contient-il déjà des données de Floppy ? */
export function hasFloppyData(dir: string): boolean {
  return MARKERS.some((m) => existsSync(join(dir, m)));
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/**
 * Choisit un nouveau répertoire de travail. Rend ce qui se passera au prochain démarrage :
 * « move » (les données suivent), « use » (le dossier a déjà des données de Floppy) ou « same » (rien ne change).
 * Refuse un chemin relatif, un dossier où l'on ne peut pas écrire, ou un dossier dans l'autre.
 */
export function chooseHome(dir: string, env: NodeJS.ProcessEnv = process.env): "move" | "use" | "same" {
  if (env.FLOPPY_HOME) throw new TextError(T("Le dossier est imposé par FLOPPY_HOME : change cette variable.", "The folder is set by FLOPPY_HOME: change that variable."));
  const raw = dir.trim();
  if (!raw || !isAbsolute(raw)) throw new TextError(T("Donne un chemin complet (exemple : D:/Floppy).", "Give a full path (example: D:/Floppy)."));
  const target = resolve(raw);
  const current = resolve(floppyHome(env));
  if (target.toLowerCase() === current.toLowerCase()) return "same";
  if (inside(target, current) || inside(current, target)) {
    throw new TextError(T("Le nouveau dossier ne peut pas être dans l'ancien (ni l'inverse).", "The new folder can't be inside the old one (or the other way round)."));
  }
  try {
    mkdirSync(target, { recursive: true });
    const probe = join(target, `.floppy-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch {
    throw new TextError(T(`Impossible d'écrire dans ${target}.`, `Can't write to ${target}.`));
  }
  const use = hasFloppyData(target);
  const back = target.toLowerCase() === resolve(defaultHome(env)).toLowerCase();
  writeJsonAtomic(pointerFile(env), {
    ...(back ? {} : { home: target }),
    ...(use ? {} : { moveFrom: current }),
  } satisfies Pointer);
  return use ? "use" : "move";
}

/**
 * Au démarrage, avant d'ouvrir quoi que ce soit : fait le déplacement demandé par chooseHome.
 * Chaque élément est renommé (même disque) ou copié puis supprimé (autre disque). Rend ce qui a été déplacé.
 */
export function applyPendingMove(log: (msg: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.FLOPPY_HOME) return [];
  const p = readPointer(env);
  if (!p.moveFrom) return [];
  const from = resolve(p.moveFrom);
  const to = resolve(p.home ?? defaultHome(env));
  const done: string[] = [];
  const keep = new Set([POINTER]); // le pointeur reste dans le dossier par défaut
  if (existsSync(from) && !hasFloppyData(to)) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (keep.has(name) && from.toLowerCase() === resolve(defaultHome(env)).toLowerCase()) continue;
      const a = join(from, name);
      const b = join(to, name);
      if (existsSync(b)) continue;
      try { renameSync(a, b); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") { log(`déplacement impossible : ${name} (${String(e)})`); continue; }
        log(`copie vers l'autre disque : ${name}${statSync(a).isDirectory() ? " (dossier)" : ""}`);
        cpSync(a, b, { recursive: true, errorOnExist: false });
        rmSync(a, { recursive: true, force: true });
      }
      done.push(name);
    }
    log(`répertoire de travail déplacé : ${from} → ${to} (${done.length} éléments)`);
  }
  writeJsonAtomic(pointerFile(env), { ...(p.home ? { home: p.home } : {}) } satisfies Pointer);
  return done;
}

/**
 * Chemin de la config : <répertoire de travail>/floppy.yml. Une ancienne config (à la racine du dépôt, ou dans le
 * dossier courant) est copiée là une fois ; l'originale n'est pas touchée.
 */
export function defaultConfigPath(home: string, legacy: string[] = [], log: (msg: string) => void = () => {}): string {
  const file = join(home, "floppy.yml");
  if (existsSync(file)) return file;
  for (const old of legacy) {
    if (!existsSync(old)) continue;
    try {
      cpSync(old, file);
      log(`config copiée dans le répertoire de travail : ${old} → ${file} (l'ancienne n'est plus lue)`);
    } catch (e) { log(`config non copiée : ${String(e)}`); }
    break;
  }
  return file;
}
