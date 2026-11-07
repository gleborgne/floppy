// Un programme local qui sert en HTTP (llama-server, audio.cpp) : le lancer par ctx.spawn, attendre qu'il réponde
// sur /health, puis le surveiller. Une seule boucle pour tous les plugins qui en lancent un.
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Context } from "../plugin/context.ts";
import { T, TextError } from "../i18n.ts";
import { killTree } from "./process.ts";
import { watchHealth } from "./health.ts";

/** Le serveur répond-il sur `<base>/health` ? */
export async function httpHealthy(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

export interface LocalServerOptions {
  /** Nom dit dans les erreurs (« llama-server »). */
  name: string;
  exe: string;
  args: string[];
  /** Adresse du serveur (http://127.0.0.1:<port>). */
  base: string;
  cwd?: string;
  /** Garder aussi la sortie standard dans la fin du journal (pas seulement les erreurs). */
  stdout?: boolean;
  startTimeout_s: number;
  /** Lignes de journal rendues dans une erreur. */
  tailLines?: number;
  /** Le serveur s'est arrêté ou ne répond plus, une fois prêt (ou pendant le démarrage, avant l'erreur levée). */
  onCrash(why: string): void;
  /** Tests : vérification de santé, et son rythme une fois prêt (30 s par défaut). */
  healthy?: (base: string, timeoutMs: number) => Promise<boolean>;
  healthEveryMs?: number;
}

/**
 * Lance le serveur et attend qu'il réponde. Rend la fonction qui l'arrête (sans appeler `onCrash`).
 * Il ne démarre pas : le serveur est arrêté et l'erreur dit pourquoi (fin du journal). Une fois prêt, il est
 * vérifié par watchHealth : figé, il est arrêté et `onCrash` est appelé (le noyau relance le plugin ou le fork).
 */
export async function startLocalServer(ctx: Context, o: LocalServerOptions): Promise<() => void> {
  const healthy = o.healthy ?? httpHealthy;
  const p: ChildProcess = ctx.spawn(o.exe, o.args, { stdio: ["ignore", o.stdout ? "pipe" : "ignore", "pipe"], ...(o.cwd ? { cwd: o.cwd } : {}) });
  let tail = "";
  const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-3000); };
  p.stdout?.on("data", keep);
  p.stderr?.on("data", keep);
  let exited = false;
  let stopping = false;
  const last = () => tail.trim().split("\n").slice(-(o.tailLines ?? 2)).join(" | ");
  p.on("exit", (code) => { exited = true; if (!stopping && ctx.alive) o.onCrash(`${o.name} s'est arrêté (code ${code}) : ${last()}`); });
  p.on("error", (err) => { exited = true; if (!stopping && ctx.alive) o.onCrash(`${o.name} : ${err.message}`); });
  let unwatch = () => {};
  const stop = () => { stopping = true; unwatch(); if (p.pid) killTree(p); else p.kill?.(); };
  const deadline = Date.now() + o.startTimeout_s * 1000;
  while (!(await healthy(o.base, 1500))) {
    if (exited || !ctx.alive) { stop(); const l = last(); throw new TextError(T(`${o.name} n'a pas démarré : ${l}`, `${o.name} didn't start: ${l}`)); }
    if (Date.now() > deadline) { stop(); const l = last(); throw new TextError(T(`${o.name} pas prêt après ${o.startTimeout_s} s : ${l}`, `${o.name} not ready after ${o.startTimeout_s} s: ${l}`)); }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Prêt : un serveur figé (il ne répond plus, sans s'arrêter) est arrêté et signalé ; le noyau le relance.
  unwatch = watchHealth(ctx, {
    check: () => healthy(o.base, 5000),
    ...(o.healthEveryMs ? { everyMs: o.healthEveryMs } : {}),
    onDead: (n) => { if (stopping || exited || !ctx.alive) return; stop(); o.onCrash(`${o.name} ne répond plus (${n} vérifications ratées)`); },
  });
  return stop;
}

/** Cherche des fichiers de modèle .gguf (profondeur limitée), sans les « mmproj » (vision). */
export function scanGguf(dirs: string[], max = 60): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6 || out.length >= max) return;
    let names: Dirent[];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return out;
}
