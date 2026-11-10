// Plugins livrés. Une entrée de la config choisit un plugin par son id (champ `plugin:`).
// Aucune liste écrite à la main : un paquet est un plugin livré quand son package.json porte un champ `floppy`,
//   "floppy": { "plugin": true, "order": 120 }          (`order` facultatif ; `"dev": true` pour un plugin de développement)
// Les paquets des workspaces (plugins/*/*) sont liés dans node_modules/@floppy : c'est là qu'on les cherche, c'est aussi
// ce que l'import dynamique sait résoudre. Chaque paquet est chargé à part : un plugin qui plante au chargement de son
// module ne bloque plus le démarrage. Ses entrées passent en erreur visible, et le reste démarre.
//
// `order` ne choisit JAMAIS un fournisseur. Le fournisseur d'un service, à défaut de slot ou de `services:`, est le premier
// actif dans l'ordre des entrées de la config (voir docs/spec/noyau.md, règle 4). `order` règle seulement l'ordre
// d'affichage du catalogue (types d'ajout d'une rubrique des réglages, rubriques fusionnées, carte des services). Sans
// `order`, un paquet vient après ceux qui en ont un, par nom : un nouveau plugin n'a rien à y mettre.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginDef } from "@floppy/core";

/** Dossier de Floppy (le dépôt, ou l'app installée). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Ce que dit le champ `floppy` du package.json d'un plugin livré. */
export interface PluginPackageInfo { name: string; order?: number; dev: boolean }

export interface DiscoveredPackages {
  packages: PluginPackageInfo[];
  /** Paquets dont le champ `floppy` est invalide. */
  failed: { pkg: string; error: string }[];
}

/** Lit le champ `floppy` d'un package.json. `undefined` : ce paquet n'est pas un plugin livré. */
export function readPluginField(pkg: unknown): PluginPackageInfo | { name: string; error: string } | undefined {
  const p = pkg as { name?: unknown; floppy?: unknown } | null;
  if (!p || typeof p.name !== "string" || p.floppy === undefined) return undefined;
  const f = p.floppy as { plugin?: unknown; order?: unknown; dev?: unknown } | null;
  if (!f || typeof f !== "object" || f.plugin !== true) return { name: p.name, error: "champ floppy invalide : { \"plugin\": true } attendu" };
  for (const k of Object.keys(f)) if (!["plugin", "order", "dev"].includes(k)) return { name: p.name, error: `champ floppy invalide : « ${k} » inconnu` };
  if (f.order !== undefined && (typeof f.order !== "number" || !Number.isFinite(f.order))) return { name: p.name, error: "champ floppy invalide : order doit être un nombre" };
  if (f.dev !== undefined && typeof f.dev !== "boolean") return { name: p.name, error: "champ floppy invalide : dev doit être vrai ou faux" };
  return { name: p.name, ...(f.order !== undefined ? { order: f.order as number } : {}), dev: f.dev === true };
}

/** Les paquets plugins livrés trouvés dans `scopeDir` (défaut : node_modules/@floppy), rangés par `order` puis par nom. */
export function discoverPackages(scopeDir = join(ROOT, "node_modules", "@floppy")): DiscoveredPackages {
  const packages: PluginPackageInfo[] = [];
  const failed: DiscoveredPackages["failed"] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(scopeDir); } catch { /* dossier absent : aucun plugin trouvé */ }
  for (const d of dirs) {
    let json: unknown;
    try { json = JSON.parse(readFileSync(join(scopeDir, d, "package.json"), "utf8")); } catch { continue; } // pas un paquet lisible
    const r = readPluginField(json);
    if (!r) continue;
    if ("error" in r) failed.push({ pkg: r.name, error: r.error }); else packages.push(r);
  }
  packages.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));
  return { packages, failed };
}

/**
 * Noms des plugins livrés, dans l'ordre du catalogue. Les plugins de développement (`"dev": true`) sont chargés seulement
 * avec FLOPPY_DEV=1 : `bench-api` répond aux accords tout seul pour le banc (en-tête X-Approval), il ne doit jamais
 * tourner dans un Floppy de tous les jours.
 */
export function shippedPackages(opts: { dev?: boolean } = {}): string[] {
  const dev = opts.dev ?? process.env.FLOPPY_DEV === "1";
  return discoverPackages().packages.filter((p) => dev || !p.dev).map((p) => p.name);
}

export interface LoadedCatalog {
  plugins: PluginDef<any>[];
  /** Paquets qui n'ont pas pu se charger, avec la raison. */
  failed: { pkg: string; error: string }[];
}

/** Charge les plugins livrés (et ceux de développement si `dev`). Un paquet qui échoue est rendu dans `failed`. */
export async function loadCatalog(opts: { dev?: boolean; packages?: readonly string[] } = {}): Promise<LoadedCatalog> {
  const found = opts.packages ? undefined : discoverPackages();
  const dev = opts.dev ?? process.env.FLOPPY_DEV === "1";
  const list = opts.packages ?? found!.packages.filter((p) => dev || !p.dev).map((p) => p.name);
  const results = await Promise.allSettled(list.map((pkg) => import(pkg) as Promise<{ default?: PluginDef<any> }>));
  const plugins: PluginDef<any>[] = [];
  const failed: LoadedCatalog["failed"] = [...(found?.failed ?? [])];
  results.forEach((r, i) => {
    const pkg = list[i]!;
    if (r.status === "rejected") failed.push({ pkg, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    else if (!r.value.default?.manifest) failed.push({ pkg, error: "pas de plugin exporté par défaut (definePlugin)" });
    else plugins.push(r.value.default);
  });
  return { plugins, failed };
}
