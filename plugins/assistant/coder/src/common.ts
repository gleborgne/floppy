// Outils communs aux deux agents (Claude, Codex) : environnement propre, recherche du CLI, garde de chemin.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { findExe, type Context } from "@floppy/core";
import type { CoderEvent } from "@floppy/contracts";

import { agentEnv } from "@floppy/agent-cli";
/** Événement sans l'id de session : la session l'ajoute. */
export type RunnerEvent = CoderEvent extends infer E ? (E extends unknown ? Omit<E, "sessionId"> : never) : never;

/** Ce que le service donne à chaque agent. */
export interface RunnerDeps {
  emit(e: RunnerEvent): void;
  log(level: "debug" | "info" | "warn" | "error", msg: string): void;
  audit(rec: { kind: string; [k: string]: unknown }): void;
  /** Demande à l'utilisateur ; rend sa réponse (faux en cas de délai). */
  ask(req: { tool: string; description: string; input?: unknown; diff?: { path: string; before?: string; after?: string } }): Promise<boolean>;
  /** Langue des messages montrés à l'utilisateur (langue de l'assistant ; défaut : français). */
  lang?: string;
  /** ctx.spawn du plugin : programme permis par le manifeste, tué à l'arrêt du plugin. */
  spawn: Context["spawn"];
}

/** Texte dans la langue demandée (français par défaut). */
export function say(lang: string | undefined, fr: string, en: string): string {
  return lang === "en" ? en : fr;
}

/** Environnement propre : pas de variables d'une session Claude parente ni d'Orca (voir @floppy/agent-cli). */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return agentEnv(extra);
}

export { findExe };

function real(p: string): string {
  // realpath du plus proche parent qui existe (le fichier peut ne pas exister encore).
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* parent suivant */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.push(cur.slice(up.length).replace(/^[\/]+/, ""));
    cur = up;
  }
}

/** Vrai si `p` (absolu, ou relatif à `base`) est dans le dossier `dir` (liens symboliques résolus). */
export function isInside(dir: string, p: string, base = dir): boolean {
  const abs = isAbsolute(p) ? p : resolve(base, p);
  let a = real(abs), d = real(dir);
  if (process.platform === "win32") { a = a.toLowerCase(); d = d.toLowerCase(); }
  const rel = relative(d, a);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export const SIGN_IN_RE = /not logged in|please run \/login|\/login|claude auth login|invalid api key|authentication[_ ]?(failed|error)|oauth token (has )?expired|unauthorized|\b401\b|not signed in|codex login|log ?in required/i;

export function signInMessage(agent: "claude" | "codex", lang?: string): string {
  return agent === "claude"
    ? say(lang, "Claude n'est pas connecté. Dans un terminal, lance « claude auth login », puis réessaie.", "Claude is not signed in. In a terminal, run “claude auth login”, then try again.")
    : say(lang, "Codex n'est pas connecté. Dans un terminal, lance « codex login », puis réessaie.", "Codex is not signed in. In a terminal, run “codex login”, then try again.");
}

export function short(s: unknown, n = 300): string {
  const t = typeof s === "string" ? s : JSON.stringify(s) ?? "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Interface d'un agent en cours. */
export interface Runner {
  send(text: string): void;
  cancel(): void;
  close(): Promise<void>;
}
