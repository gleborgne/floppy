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
  const pointer = readPointer(env);
  // Déplacement demandé mais pas encore fait (ou raté) : les données sont encore entières dans l'ancien dossier.
  if (pointer.moveFrom && isAbsolute(pointer.moveFrom) && existsSync(pointer.moveFrom)) return pointer.moveFrom;
  const chosen = pointer.home;
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
  // Un dossier personnel (Documents…) ne devient jamais le dossier de Floppy : un déplacement suivant emporterait
  // les fichiers de l'utilisateur avec ceux de Floppy.
  if (!use && !back && readdirSync(target).some((n) => !n.startsWith(".floppy-"))) {
    throw new TextError(T("Ce dossier contient déjà d'autres fichiers. Choisis un dossier vide, ou un dossier qui contient déjà les données de Floppy.",
      "This folder already holds other files. Choose an empty folder, or a folder that already holds Floppy's data."));
  }
  writeJsonAtomic(pointerFile(env), {
    ...(back ? {} : { home: target }),
    ...(use ? {} : { moveFrom: current }),
  } satisfies Pointer);
  return use ? "use" : "move";
}

/** Fichiers laissés en place : ouverts par l'app pendant le déplacement, ou propres à une session. */
const LEFT_BEHIND = new Set(["kernel.log", "kernel.1.log", "control.json"]);
const STAGING = ".floppy-move";

export interface MoveResult {
  /** Éléments déplacés (vide : rien à faire, ou échec). */
  moved: string[];
  /** Raison d'un échec : rien n'a changé, Floppy reste dans l'ancien dossier et réessaiera au prochain démarrage. */
  error?: string;
}

/** Dossier d'origine d'un déplacement pas encore fait (pour arrêter ses programmes restés en vie avant de déplacer). */
export function pendingMoveFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.FLOPPY_HOME) return undefined;
  const from = readPointer(env).moveFrom;
  return from && isAbsolute(from) ? from : undefined;
}

/**
 * Au démarrage, avant d'ouvrir quoi que ce soit : fait le déplacement demandé par chooseHome, tout ou rien.
 * 1. Chaque élément passe dans un dossier d'attente du nouveau dossier (renommé sur le même disque ; copié dans
 *    `<nom>.part` puis renommé sur un autre disque).
 * 2. Un élément impossible (fichier tenu par un programme, disque plein) : tout ce qui a été renommé revient à sa place,
 *    les copies sont effacées, `moveFrom` reste. Floppy démarre dans l'ancien dossier, entier, et réessaiera.
 * 3. Tout est passé : les éléments sortent du dossier d'attente, le pointeur ne garde que le nouveau dossier, puis
 *    les originaux copiés sont effacés (un arrêt à ce moment laisse seulement des restes dans l'ancien dossier).
 */
export function applyPendingMove(
  log: (msg: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env,
  ops: { renameSync: (a: string, b: string) => void } = { renameSync },
): MoveResult {
  if (env.FLOPPY_HOME) return { moved: [] };
  const p = readPointer(env);
  if (!p.moveFrom) return { moved: [] };
  const from = resolve(p.moveFrom);
  const to = resolve(p.home ?? defaultHome(env));
  const finish = () => writeJsonAtomic(pointerFile(env), { ...(p.home ? { home: p.home } : {}) } satisfies Pointer);
  if (!existsSync(from)) { finish(); return { moved: [] }; }
  const fromIsDefault = from.toLowerCase() === resolve(defaultHome(env)).toLowerCase();
  const staging = join(to, STAGING);
  const names = readdirSync(from).filter((n) => !LEFT_BEHIND.has(n) && !(fromIsDefault && n === POINTER));
  const renamed: string[] = [];   // passés par renommage : à remettre en place en cas d'échec
  const copied: string[] = [];    // passés par copie : l'original est encore dans l'ancien dossier
  try {
    mkdirSync(staging, { recursive: true });
    for (const name of names) {
      const a = join(from, name);
      const b = join(staging, name);
      rmSync(`${b}.part`, { recursive: true, force: true });
      if (existsSync(b)) rmSync(b, { recursive: true, force: true }); // reste d'un essai interrompu : on refait
      try { ops.renameSync(a, b); renamed.push(name); continue; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw new Error(`${name} : ${(e as Error).message}`); }
      log(`copie vers l'autre disque : ${name}${statSync(a).isDirectory() ? " (dossier)" : ""}`);
      cpSync(a, `${b}.part`, { recursive: true, errorOnExist: true, force: false });
      ops.renameSync(`${b}.part`, b);
      copied.push(name);
    }
    for (const name of [...renamed, ...copied]) {
      const b = join(to, name);
      if (existsSync(b)) renameSync(b, `${b}.avant-${Date.now()}`); // jamais écrasé : mis de côté
      renameSync(join(staging, name), b);
    }
    rmSync(staging, { recursive: true, force: true });
  } catch (e) {
    // Retour en arrière : l'ancien dossier redevient entier, le nouveau ne garde rien du déplacement.
    for (const name of renamed) {
      const back = existsSync(join(staging, name)) ? join(staging, name) : join(to, name);
      try { if (!existsSync(join(from, name))) renameSync(back, join(from, name)); } catch (r) { log(`retour impossible : ${name} (${String(r)})`); }
    }
    for (const name of copied) { try { rmSync(join(to, name), { recursive: true, force: true }); } catch { /* reste */ } }
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* reste */ }
    const error = e instanceof Error ? e.message : String(e);
    log(`déplacement du répertoire de travail impossible, rien n'a changé (nouvel essai au prochain démarrage) : ${error}`);
    return { moved: [], error };
  }
  finish();
  for (const name of copied) { try { rmSync(join(from, name), { recursive: true, force: true }); } catch (e) { log(`reste dans l'ancien dossier : ${name} (${String(e)})`); } }
  log(`répertoire de travail déplacé : ${from} → ${to} (${renamed.length + copied.length} éléments)`);
  return { moved: [...renamed, ...copied] };
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
