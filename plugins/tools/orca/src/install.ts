// Bouton « Installer dans Orca » / « Mettre à jour dans Orca » : met le plugin Orca « Floppy » (dossier ../orca-plugin)
// dans <home>/orca-plugin, puis le charge dans Orca comme dossier de développement.
// Orca demande un accord avant de lancer du code. Le clic de l'utilisateur sur le bouton est cet accord : on le donne
// seulement si Orca décrit exactement l'accès prévu (lire l'état des agents), sinon on s'arrête et on explique.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { T, type OpResult } from "@floppy/core";
import { resolveExe, spawnSpec } from "./index.ts";

/** Le plugin Orca livré avec Floppy. */
export const ORCA_PLUGIN_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "orca-plugin");
export const ORCA_PLUGIN_KEY = "local.floppy";

/** Réponse brute d'une commande `orca … --json` : code de sortie et JSON (même en cas d'échec). */
export interface OrcaReply { code: number; json?: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; data?: unknown } } }
export type OrcaRawCli = (args: string[]) => Promise<OrcaReply>;

export const rawCli = (command: string): OrcaRawCli => (args) =>
  new Promise((resolve) => {
    const spec = spawnSpec(resolveExe(command), [...args, "--json"]);
    execFile(spec.file, spec.args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: spec.verbatim }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      let json: OrcaReply["json"];
      try { json = JSON.parse(stdout) as OrcaReply["json"]; } catch { /* pas de JSON : Orca absent ou fermé */ }
      resolve({ code, json });
    });
  });

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
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, { recursive: true });
  // Un ancien dossier de développement avec la même clé (ex. le dossier du dépôt) laisserait la place à la copie.
  await cli(["plugin", "dev", "unload", ORCA_PLUGIN_KEY]);
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
