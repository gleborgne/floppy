// Cycle de vie du noyau : lancé comme utilityProcess, surveillé, relancé avec une attente qui grandit ; son journal ;
// les demandes de l'app au noyau (réponse attendue) ; le MessagePort entre l'avatar et le noyau.
// Propriétaire du processus du noyau, de son journal, de ses pannes récentes et des demandes en attente.
import { utilityProcess, MessageChannelMain } from "electron";
import type { UtilityProcess, BrowserWindow } from "electron";
import { createWriteStream, mkdirSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import { TEXTS } from "./main-texts.ts";
import type { Msg, Say, Reply } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";

const RESTART_DELAYS = [2000, 5000, 15000, 60000];
const CRASH_WINDOW = 120000;
const CRASH_MAX = 5;
/** Pannes récentes (la dernière comprise) → attente avant la relance, ou null : trop de pannes, on arrête et on le montre. */
export function restartDelay(times: number[], now: number): number | null {
  const recent = times.filter((t) => now - t < CRASH_WINDOW);
  if (recent.length >= CRASH_MAX) return null;
  return RESTART_DELAYS[Math.min(Math.max(recent.length - 1, 0), RESTART_DELAYS.length - 1)]!;
}

export interface KernelProcessDeps {
  /** Dossier assistant/ : répertoire de travail du noyau. */
  root: string;
  /** Config imposée (FLOPPY_CONFIG), ou null. */
  config: string | null;
  /** Fichier du noyau lancé dans le utilityProcess (kernel.ts). */
  entry: string;
  texts: Texts;
  quitting(): boolean;
  /** Problèmes montrés dans l'icône (propriétaire : l'icône). */
  problems: Pick<Map<string, Say>, "set" | "delete" | "clear">;
  refreshTray(): void;
  /** Un message du noyau (après les gardes de fermeture et de relance). */
  onMessage(m: Msg, source: UtilityProcess): void;
  /** Le noyau est parti : ses contributions de bureau disparaissent. */
  clearContributions(): void;
  /** La fenêtre de l'avatar et si sa page est chargée (pour le port du corps). */
  avatar(): { win(): BrowserWindow | null; winReady(): boolean };
}

export interface KernelProcess {
  kernel(): UtilityProcess | null;
  running(): boolean;
  logDir(): string;
  /** Journal du noyau (kernel.log) : suit le dossier de travail quand il change. */
  log: { write(chunk: string | Buffer): void };
  start(): void;
  restart(): void;
  /** Le noyau demande un port pour le corps : on le connecte dès que l'avatar est prête. */
  bodyPortRequested(): void;
  connectBody(): void;
  hasBodyPort(): boolean;
  setBootFailure(failure: Say | null): void;
  /** reqId → résolution de la réponse du noyau. */
  pending: Map<number, Reply>;
  request(msg: Msg): Promise<any>;
  coderRequest(msg: Msg): Promise<any>;
}

export function createKernelProcess(deps: KernelProcessDeps): KernelProcess {
  const { root: ROOT, config: CONFIG, entry, texts } = deps;
  const { T } = texts;
  const problems = deps.problems;
  let kernel: UtilityProcess | null = null;
  let kernelWantsPort = false;
  let currentPorts: MessageChannelMain | null = null;
  let reqSeq = 0;
  let crashes: number[] = [];               // heures des dernières pannes du noyau (relance avec une attente qui grandit)
  let restarting = false;         // relance demandée (menu, réglage) : pas une panne
  let bootFailure: Say | null = null;         // raison d'un démarrage impossible, envoyée par le noyau avant de s'arrêter
  const pending = new Map<number, Reply>();      // reqId → résolution de la réponse du noyau

  // ------------------------------------------------------------------ journal du noyau
  // Dossier de données (le même que celui du noyau). L'ancien nom « assistant » est déplacé une fois.
  const dataParent = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(process.env.HOME ?? ROOT, ".local", "share");
  /**
   * Répertoire de travail, comme le noyau le trouve (packages/core/src/util/home.ts) : FLOPPY_HOME, sinon le dossier
   * choisi (pointeur <dossier par défaut>/home.json), sinon le dossier par défaut.
   */
  function homeDir(): string {
    if (process.env.FLOPPY_HOME) return process.env.FLOPPY_HOME;
    const base = join(dataParent, "floppy");
    try {
      const p = JSON.parse(readFileSync(join(base, "home.json"), "utf8"));
      // Déplacement pas encore fait : les données sont encore dans l'ancien dossier (comme le noyau).
      if (typeof p?.moveFrom === "string" && p.moveFrom && existsSync(p.moveFrom)) return p.moveFrom;
      const chosen = p?.home;
      // Dossier choisi absent (disque débranché) : dossier par défaut, comme le noyau.
      if (typeof chosen === "string" && chosen) {
        try { mkdirSync(chosen, { recursive: true }); return chosen; } catch { /* dossier par défaut */ }
      }
    } catch { /* pas de pointeur : dossier par défaut */ }
    if (!existsSync(base) && existsSync(join(dataParent, "assistant"))) {
      try { renameSync(join(dataParent, "assistant"), base); } catch { return join(dataParent, "assistant"); }
    }
    return base;
  }
  function openLog(dir: string): WriteStream {
    try { mkdirSync(dir, { recursive: true }); } catch { /* disque absent : le noyau choisira le dossier par défaut */ }
    // Au-delà de 20 Mo, le journal devient kernel.1.log (l'ancien est remplacé) : il ne grossit jamais sans limite.
    try { if (statSync(join(dir, "kernel.log")).size > 20 * 1024 * 1024) renameSync(join(dir, "kernel.log"), join(dir, "kernel.1.log")); } catch { /* absent */ }
    const stream = createWriteStream(join(dir, "kernel.log"), { flags: "a" });
    // Journal impossible à ouvrir ou à écrire : l'app continue sans lui (jamais une erreur qui l'arrête).
    stream.on("error", (e: Error) => { try { process.stderr.write(`[app] journal : ${e?.message ?? e}\n`); } catch { /* rien */ } });
    return stream;
  }
  let logDir = homeDir();
  let kernelLog = openLog(logDir);
  const log = { write: (chunk: string | Buffer) => { kernelLog.write(chunk); } };

  // ------------------------------------------------------------------ noyau
  function startKernel() {
    kernelWantsPort = false;
    problems.clear();
    // La raison du dernier démarrage raté reste visible jusqu'à un démarrage réussi (kernel.ready).
    if (bootFailure) problems.set("kernel", bootFailure);
    // Nouveau répertoire de travail choisi : le journal suit.
    const dir = homeDir();
    if (dir !== logDir) { kernelLog.end(); logDir = dir; kernelLog = openLog(logDir); }
    kernel = utilityProcess.fork(entry, CONFIG ? [CONFIG] : [], { stdio: "pipe", serviceName: "Floppy - noyau", cwd: ROOT });
    const source = kernel;
    const forward = (d: Buffer) => { process.stdout.write(d); kernelLog.write(d); };
    kernel.stdout?.on("data", forward);
    kernel.stderr?.on("data", forward);
    kernel.on("message", (m: Msg) => {
      if (deps.quitting() || kernel !== source) return;
      deps.onMessage(m, source);
    });
    kernel.on("exit", (code: number) => {
      if (kernel !== source) return;
      kernel = null;
      deps.clearContributions();
      currentPorts = null;
      // Les demandes en cours n'auront jamais de réponse : on les clôt tout de suite (sinon 30-60 s d'attente).
      for (const [id, done] of [...pending]) { pending.delete(id); try { done({ ok: false, text: T("noAnswer"), error: T("noAnswer") }); } catch { /* résolveur déjà parti */ } }
      if (deps.quitting()) return;
      if (restarting) { restarting = false; startKernel(); return; }
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW), now];
      const delay = restartDelay(crashes, now);
      if (delay === null) {
        // Le noyau s'arrête sans cesse (souvent : floppy.yml invalide) : on ne relance plus, on montre pourquoi.
        problems.set("kernel", bootFailure ?? { fr: TEXTS.fr.kernelLoop, en: TEXTS.en.kernelLoop });
        kernelLog.write(`\n[app] le noyau s'est arrêté ${crashes.length} fois en 2 min (code ${code}) : relance arrêtée\n`);
        deps.refreshTray();
        return;
      }
      if (bootFailure) problems.set("kernel", bootFailure);
      deps.refreshTray();
      kernelLog.write(`\n[app] le noyau s'est arrêté (code ${code}) : relance dans ${delay / 1000} s\n`);
      setTimeout(() => { if (!kernel && !deps.quitting()) startKernel(); }, delay);
    });
    deps.refreshTray();
  }

  function restartKernel() {
    // Relance à la main : on repart de zéro (pannes oubliées, problème du noyau effacé).
    crashes = [];
    bootFailure = null;
    problems.delete("kernel");
    if (!kernel) return startKernel();
    restarting = true;
    kernel.postMessage({ type: "stop" });
    const k = kernel;
    setTimeout(() => { if (k === kernel) k.kill(); }, 6000);
  }

  /** Un nouveau MessagePort entre l'avatar et le noyau (au démarrage, et à chaque rechargement de la fenêtre). */
  function connectBody() {
    const win = deps.avatar().win();
    const winReady = deps.avatar().winReady();
    if (!kernel || !kernelWantsPort || !win || !winReady) return;
    if (currentPorts) { try { currentPorts.port1.close(); } catch { /* déjà fermé */ } }
    currentPorts = new MessageChannelMain();
    kernel.postMessage({ type: "body-port" }, [currentPorts.port1]);
    win.webContents.postMessage("body-port", null, [currentPorts.port2]);
  }

  function kernelRequest(msg: Msg): Promise<any> {
    if (!kernel) return Promise.resolve({ ok: false, text: T("noKernel") });
    const reqId = ++reqSeq;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(reqId); res({ ok: false, text: T("noAnswer") }); }, 60000);
      pending.set(reqId, (r) => { clearTimeout(t); res(r); });
      kernel?.postMessage({ ...msg, reqId });
    });
  }
  // Assistant IA : relais fenêtre des réglages ↔ service « coder » du noyau.
  const coderCall = (msg: Msg): Promise<any> => {
    if (!kernel) return Promise.resolve({ ok: false, error: T("noKernel") });
    const reqId = ++reqSeq;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(reqId); res({ ok: false, error: T("noAnswer") }); }, 30000);
      pending.set(reqId, (r) => { clearTimeout(t); res(r); });
      kernel?.postMessage({ ...msg, reqId });
    });
  };

  return {
    kernel: () => kernel, running: () => !!kernel, logDir: () => logDir, log,
    start: startKernel, restart: restartKernel,
    bodyPortRequested: () => { kernelWantsPort = true; connectBody(); },
    connectBody, hasBodyPort: () => !!currentPorts,
    setBootFailure: (failure) => { bootFailure = failure; },
    pending, request: kernelRequest, coderRequest: coderCall,
  };
}
