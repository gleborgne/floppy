// Ce que partagent les plugins qui lancent un agent en ligne de commande (Claude Code, Codex, Antigravity) :
// l'environnement nettoyé, la config de Codex qui coupe tout sauf le serveur MCP Floppy, et la lecture du JSON
// d'une réponse. Une bibliothèque, pas un plugin : les plugins l'importent sans s'importer entre eux.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export { offerAgent, borrowAgent, validAgentModel, agentTools, type AgentDefinition } from "./offers.ts";
export { createExternalAgent } from "./plugin.ts";
export { scopedAgentRun } from "./scoped-run.ts";
export { createModelCatalog, type AgentModel } from "./model-catalog.ts";
export { CliConversation } from "./conversation.ts";
export { ReplyTags, withEmotionTags } from "./emotion.ts";
export { discoverCodexModels, discoverClaudeModels, discoverAgyModels } from "./model-discovery.ts";

/** Variables du système gardées pour un agent : rien d'une session Claude parente, d'Orca ou d'une clé en trop. */
const BASE_ENV = [
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "COMPUTERNAME", "LANG",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
];

export interface AgentEnvOptions {
  /** Variables en plus à garder (ex. HOME, CODEX_HOME pour Codex). */
  also?: string[];
  /** Variables de la liste de base à ne pas garder (ex. le dossier de l'utilisateur, remplacé par une maison isolée). */
  drop?: string[];
  /** Environnement lu (défaut : process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Environnement propre pour lancer un agent, plus `extra`. Les noms se comparent sans tenir compte de la casse. */
export function agentEnv(extra: Record<string, string> = {}, opts: AgentEnvOptions = {}): Record<string, string> {
  const drop = new Set((opts.drop ?? []).map((n) => n.toUpperCase()));
  const keep = new Set([...BASE_ENV, ...(opts.also ?? [])].map((n) => n.toUpperCase()).filter((n) => !drop.has(n)));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined && keep.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...extra };
}

/** Fonctions de Codex coupées pour tous les usages de Floppy (le shell est décidé par chaque plugin). */
export const CODEX_FEATURES_OFF = [
  "plugins", "apps", "hooks", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "multi_agent", "view_image", "goals", "tool_suggest", "skill_search", "sleep_tool", "memories",
  "in_app_browser", "skill_mcp_dependency_install", "workspace_dependencies", "remote_plugin",
];

/** Serveurs MCP déclarés dans ~/.codex/config.toml (lu seulement) : on les coupe par des surcharges -c. */
export function userCodexMcpNames(home: string = homedir()): string[] {
  try {
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    return [...toml.matchAll(/^\[mcp_servers\.([^.\]\s]+)\]/gm)].map((m) => m[1]!.replace(/^["']|["']$/g, ""));
  } catch { return []; }
}

export interface CodexMcpOptions {
  /** Adresse du serveur MCP Floppy. Son jeton passe par la variable FLOPPY_MCP_TOKEN. */
  mcpUrl: string;
  /** Outils de Floppy acceptés sans question côté Codex (l'accord est tenu par le noyau). */
  tools: string[];
  /** Serveurs MCP de l'utilisateur à couper. */
  userMcp: string[];
  /** Fonctions coupées en plus de CODEX_FEATURES_OFF (ex. shell_tool, unified_exec). */
  alsoOff?: string[];
}

/** Surcharges -c communes : fonctions coupées, serveurs de l'utilisateur coupés, seul le serveur MCP Floppy reste. */
export function codexMcpOverrides(o: CodexMcpOptions): string[] {
  const c: string[] = [];
  for (const f of [...CODEX_FEATURES_OFF, ...(o.alsoOff ?? [])]) c.push("-c", `features.${f}=false`);
  for (const n of o.userMcp) c.push("-c", `mcp_servers.${n}.enabled=false`);
  const approve = o.tools.map((t) => `${t}={approval_mode="approve"}`).join(",");
  c.push("-c", `mcp_servers.floppy={url="${o.mcpUrl}",bearer_token_env_var="FLOPPY_MCP_TOKEN",tools={${approve}}}`);
  return c;
}

/**
 * Trouve le JSON dans une réponse de modèle : avec ou sans ```json, avec ou sans texte autour.
 * Rend undefined s'il n'y en a pas (à l'appelant de dire l'erreur).
 */
export function parseModelJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(s); } catch { /* texte autour : on cherche le premier objet ou tableau */ }
  const a = s.search(/[{[]/);
  if (a < 0) return undefined;
  const b = s.lastIndexOf(s[a] === "{" ? "}" : "]");
  if (b <= a) return undefined;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return undefined; }
}
