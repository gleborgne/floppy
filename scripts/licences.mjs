// Vérifie les licences des paquets installés.
// - Dépendances livrées (prod) : échec (code 1) si une licence n'est pas permissive.
// - Outils de dev (vitest, typescript…) : seulement un avertissement (ils ne sont pas livrés).
//   node scripts/licences.mjs
import { execSync } from "node:child_process";

const PERMISSIVE = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|Unlicense|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|Python-2\.0|MIT-0)$/i;
// Paquets vérifiés à la main (licence absente ou mal déclarée dans package.json).
const ALLOW = new Set([]);

function licenceOf(p) {
  const l = p.license;
  if (typeof l === "string") return l;
  if (l?.type) return l.type;
  if (Array.isArray(p.licenses)) return p.licenses.map((x) => x.type ?? x).join(" OR ");
  return "?";
}

/** Une expression SPDX est permissive si une branche OR est entièrement permissive. */
function isPermissive(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean.split(/\s+OR\s+/i).some((branch) => branch.split(/\s+AND\s+/i).every((id) => PERMISSIVE.test(id.trim())));
}

function query(selector) {
  const out = execSync(`npm query "${selector}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const seen = new Map();
  for (const p of JSON.parse(out)) {
    if (p.private || !p.name) continue;
    seen.set(`${p.name}@${p.version}`, licenceOf(p));
  }
  return seen;
}

function check(label, pkgs) {
  const by = {};
  const bad = [];
  for (const [k, l] of pkgs) {
    (by[l] ??= []).push(k);
    if (!isPermissive(l) && !ALLOW.has(k.replace(/@[^@]+$/, ""))) bad.push(`${k} (${l})`);
  }
  console.log(`${label} : ${pkgs.size} paquets — ` + Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([l, ks]) => `${l} ${ks.length}`).join(", "));
  return bad;
}

const prod = query(".prod");
const dev = query(".dev");
for (const k of prod.keys()) dev.delete(k);

const badProd = check("Livrés", prod);
const badDev = check("Dev", dev);
if (badDev.length) console.warn(`  (dev, non livrés) à surveiller : ${badDev.join(", ")}`);
if (badProd.length) {
  console.error(`\nLicences refusées ou inconnues dans les dépendances livrées (${badProd.length}) :\n  ${badProd.join("\n  ")}`);
  process.exit(1);
}
console.log("Licences : OK");
