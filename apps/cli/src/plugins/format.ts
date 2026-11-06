// Format d'un plugin distribué (plugin tiers) : un dossier avec `floppy-plugin.json` et `index.ts`.
// Le fichier JSON est lu SANS exécuter de code : c'est lui que la revue, l'installation et la fenêtre des réglages montrent.
// Le manifeste du code (index.ts) doit lui correspondre : c'est vérifié dans le processus isolé, au chargement.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestError, T, TextError, type Manifest, type Permissions, type Text } from "@floppy/core";

/** Version de l'API des plugins (forme de ctx). Un plugin déclare celle qu'il vise dans `api`. */
export const PLUGIN_API = 1;
export const PACKAGE_FILE = "floppy-plugin.json";
export const ID_RE = /^[a-z][a-z0-9-]*$/;

export interface PluginPackage {
  id: string;
  version: string;
  licence: string;
  description?: Text;
  /** Version de l'API visée (PLUGIN_API). */
  api: number;
  /** Seuls `net` (hôtes joignables) et `cloud` sont permis à un plugin tiers. */
  permissions?: Pick<Permissions, "net" | "cloud">;
  homepage?: string;
  /** Rubriques de la fenêtre des réglages ajoutées par le plugin. */
  sections?: Manifest["sections"];
}

/** Droits qu'un plugin tiers ne peut pas recevoir : son processus n'a ni fichiers, ni programmes, ni accords. */
const FORBIDDEN_PERMS = ["fs.read", "fs.write", "exec", "approvals"] as const;

export function hasPackage(dir: string): boolean {
  return existsSync(join(dir, PACKAGE_FILE));
}

/** Valide un objet floppy-plugin.json. Rend la liste des problèmes (vide = valide). */
export function packageProblems(x: unknown): Text[] {
  if (!x || typeof x !== "object" || Array.isArray(x)) return [T("floppy-plugin.json doit contenir un objet", "floppy-plugin.json must contain an object")];
  const p = x as Record<string, unknown>;
  const out: Text[] = [];
  const bad = manifestError(p);
  if (bad) out.push(T(`manifeste invalide : ${bad}`, `invalid manifest: ${bad}`));
  if (p.api !== PLUGIN_API) {
    out.push(T(`api : ${String(p.api)} n'est pas pris en charge (attendu : ${PLUGIN_API})`, `api: ${String(p.api)} is not supported (expected: ${PLUGIN_API})`));
  }
  const perms = (p.permissions ?? {}) as Record<string, unknown>;
  for (const k of FORBIDDEN_PERMS) {
    if (perms[k] !== undefined) out.push(T(`permissions.${k} n'est pas permis à un plugin tiers`, `permissions.${k} is not allowed for a third-party plugin`));
  }
  if (p.homepage !== undefined && (typeof p.homepage !== "string" || !/^https:\/\//.test(p.homepage))) {
    out.push(T("homepage : une adresse https:// est attendue", "homepage: an https:// address is expected"));
  }
  return out;
}

/** Lit et valide floppy-plugin.json. Lève une TextError au texte clair. */
export function readPackage(dir: string): PluginPackage {
  const file = join(dir, PACKAGE_FILE);
  if (!existsSync(file)) throw new TextError(T(`${PACKAGE_FILE} manquant`, `${PACKAGE_FILE} is missing`));
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    throw new TextError(T(`${PACKAGE_FILE} illisible : ${(e as Error).message}`, `${PACKAGE_FILE} cannot be read: ${(e as Error).message}`));
  }
  const problems = packageProblems(raw);
  if (problems.length) throw new TextError(problems[0]!);
  return raw as PluginPackage;
}

/** Le manifeste du code (index.ts) correspond-il au fichier JSON ? Rend le problème, ou undefined. */
export function manifestMismatch(pkg: PluginPackage, m: Record<string, unknown>): Text | undefined {
  if (m.id !== pkg.id) return T(`manifest.id « ${String(m.id)} » ≠ « ${pkg.id} » (${PACKAGE_FILE})`, `manifest.id "${String(m.id)}" ≠ "${pkg.id}" (${PACKAGE_FILE})`);
  if (m.version !== pkg.version) return T(`manifest.version « ${String(m.version)} » ≠ « ${pkg.version} »`, `manifest.version "${String(m.version)}" ≠ "${pkg.version}"`);
  const a = JSON.stringify(normPerms(m.permissions as Permissions | undefined));
  const b = JSON.stringify(normPerms(pkg.permissions));
  if (a !== b) return T(`les droits du code diffèrent de ceux de ${PACKAGE_FILE}`, `the code's permissions differ from ${PACKAGE_FILE}`);
  for (const k of ["provides", "inject", "optional", "slots", "tasks", "serviceSelection", "addable", "lazy", "runtime"]) {
    if (m[k] !== undefined && !(Array.isArray(m[k]) && (m[k] as unknown[]).length === 0)) {
      return T(`manifest.${k} n'est pas permis à un plugin tiers`, `manifest.${k} is not allowed for a third-party plugin`);
    }
  }
  return undefined;
}

function normPerms(p: Permissions | undefined): unknown {
  return { net: [...(p?.net ?? [])].sort(), cloud: p?.cloud === true, other: Object.keys(p ?? {}).filter((k) => k !== "net" && k !== "cloud").sort() };
}
