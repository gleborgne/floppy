// Bouton « Installer dans Orca » / « Mettre à jour dans Orca » : met le plugin Orca « Floppy » (dossier ../orca-plugin)
// dans <home>/orca-plugin, puis le charge dans Orca comme dossier de développement.
// Orca demande un accord avant de lancer du code. Le clic de l'utilisateur sur le bouton est cet accord : on le donne
// seulement si Orca décrit exactement l'accès prévu (lire l'état des agents), sinon on s'arrête et on explique.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { T, type Context, type OpResult } from "@floppy/core";
import { resolveExe, spawnSpec } from "./index.ts";

/** Le plugin Orca livré avec Floppy. */
export const ORCA_PLUGIN_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "orca-plugin");
export const ORCA_PLUGIN_KEY = "local.floppy";

/** Réponse brute d'une commande `orca … --json` : code de sortie et JSON (même en cas d'échec). */
export interface OrcaReply { code: number; json?: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; data?: unknown } } }
export type OrcaRawCli = (args: string[]) => Promise<OrcaReply>;

export const rawCli = (command: string, exec: Context["exec"]): OrcaRawCli => async (args) => {
  const spec = spawnSpec(resolveExe(command), [...args, "--json"]);
  let r: { stdout: string; code: number };
  try { r = await exec(spec.file, spec.args, { timeoutMs: 30000, maxBuffer: 4 * 1024 * 1024, verbatim: spec.verbatim, allowFailure: true }); }
  catch { return { code: -1 }; } // Orca absent, ou délai dépassé
  let json: OrcaReply["json"];
  try { json = JSON.parse(r.stdout) as OrcaReply["json"]; } catch { /* pas de JSON : Orca absent ou fermé */ }
  return { code: r.code, json };
};

/** Empreinte du contenu d'un dossier (fichiers et chemins), pour savoir si la copie est à jour. */
export function folderHash(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith(".")) continue; // .orca : typages écrits par Orca
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else h.update(relative(dir, f).replace(/\\/g, "/")).update("\0").update(readFileSync(f)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** État de la copie : absente, à jour, ou plus ancienne que le plugin livré avec Floppy. */
export function copyState(home: string, src: string = ORCA_PLUGIN_SRC): "absent" | "a_jour" | "ancien" {
  const cur = folderHash(join(home, "orca-plugin"));
  if (!cur) return "absent";
  return cur === folderHash(src) ? "a_jour" : "ancien";
}

/** L'accord demandé par Orca est-il exactement celui prévu ? (plugin Floppy, worker, lecture de l'état des agents) */
export function expectedGrant(data: unknown): string | undefined {
  const d = data as { pluginKey?: unknown; approvalFingerprint?: unknown; grants?: { execution?: unknown; capabilities?: { kind?: unknown }[]; contributions?: { kind?: unknown; name?: unknown }[] } } | undefined;
  const fp = d?.approvalFingerprint;
  if (d?.pluginKey !== ORCA_PLUGIN_KEY || typeof fp !== "string" || !/^ap1-[0-9a-f]{8,128}$/.test(fp)) return undefined;
  const g = d.grants;
  if (g?.execution !== "trusted-worker") return undefined;
  const caps = (g.capabilities ?? []).map((c) => c.kind);
  if (caps.length !== 1 || caps[0] !== "agent:read") return undefined;
  if ((g.contributions ?? []).some((c) => !(c.kind === "events" && c.name === "agent.status.changed"))) return undefined;
  return fp;
}

/**
 * Met `dir` à l'image de `src`, fichier par fichier, sans supprimer `dir` lui-même : sous Windows, un dossier
 * surveillé par Orca ne se supprime pas (EIO / EPERM), mais ses fichiers se remplacent. `.orca/` (typages d'Orca) est gardé.
 */
export function syncFolder(src: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const want = new Set(readdirSync(src));
  for (const n of readdirSync(dir)) {
    if (n.startsWith(".") || want.has(n)) continue;
    rmSync(join(dir, n), { recursive: true, force: true });
  }
  for (const n of want) {
    const s = join(src, n), d = join(dir, n);
    if (statSync(s).isDirectory()) {
      if (existsSync(d) && !statSync(d).isDirectory()) rmSync(d, { force: true });
      syncFolder(s, d);
    } else {
      if (existsSync(d) && statSync(d).isDirectory()) rmSync(d, { recursive: true, force: true });
      copyFileSync(s, d);
    }
  }
}

const why = (r: OrcaReply): string => r.json?.error?.message?.split("\n")[0] ?? (r.json ? `code ${r.code}` : "pas de réponse");

/** Copie le plugin dans <home>/orca-plugin et le charge dans Orca. */
export async function installOrcaPlugin(home: string, cli: OrcaRawCli, src: string = ORCA_PLUGIN_SRC): Promise<OpResult> {
  const dir = join(home, "orca-plugin");
  // Le chemin passe dans une ligne de commande : on refuse ce que cmd.exe interpréterait même entre guillemets.
  if (/["%!^\r\n]/.test(dir)) return { ok: false, text: T(`Chemin non pris en charge : ${dir}`, `Unsupported path: ${dir}`) };
  const ping = await cli(["plugin", "list"]);
  if (!ping.json?.ok) {
    return { ok: false, text: T("Orca ne répond pas. Ouvre Orca, puis réessaie.", "Orca is not responding. Open Orca, then try again.") };
  }
  // D'abord retirer le dossier de dev de même clé (la copie actuelle, ou le dossier du dépôt) : Orca lâche le dossier.
  await cli(["plugin", "dev", "unload", ORCA_PLUGIN_KEY]);
  try { syncFolder(src, dir); } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, text: T(
      `Floppy n'a pas pu copier le plugin (un fichier est occupé ?). Ferme Orca, puis réessaie. Détail : ${m}`,
      `Floppy could not copy the plugin (a file is busy?). Close Orca, then try again. Detail: ${m}`) };
  }
  let r = await cli(["plugin", "dev", "load", dir]);
  if (r.code === 3 || r.json?.error?.code === "approval_required" || r.json?.error?.code === "approval_stale") {
    const fp = expectedGrant(r.json?.error?.data);
    if (!fp) {
      return { ok: false, text: T(
        "Orca demande un accès différent de celui prévu. Floppy n'a rien autorisé. Regarde dans Orca : Réglages, Plugins.",
        "Orca asks for different access than planned. Floppy approved nothing. Look in Orca: Settings, Plugins.") };
    }
    r = await cli(["plugin", "dev", "load", dir, "--approve", fp]);
  }
  if (!r.json?.ok) return { ok: false, text: T(`Orca a refusé le plugin : ${why(r)}`, `Orca refused the plugin: ${why(r)}`) };
  return { ok: true, text: T(
    "Plugin installé dans Orca. Floppy sera prévenu dès qu'un agent change d'état.",
    "Plugin installed in Orca. Floppy will hear as soon as an agent changes state.") };
}
