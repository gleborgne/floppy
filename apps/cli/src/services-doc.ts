// Carte des services, écrite dans docs/spec/noyau.md à partir du code : jamais en retard.
// - Qui fournit, qui utilise : lu dans les manifestes des plugins livrés (provides, inject, optional, slots).
// - Où vit chaque contrat, et ce qu'il dit : lu dans packages/core/src/services.ts et packages/contracts/src.
// - Liens entre contrats : un contrat qui cite le type d'un autre service (ex. `llm` peut porter un agent `brain`).
// Regénérer : `npm run docs:services`. Le test apps/cli/test/services-doc.test.ts échoue si la doc ne suit plus.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "@floppy/core";
import { extractInterface } from "./plugins/wiki.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DOC = join(ROOT, "docs", "spec", "noyau.md");
export const BEGIN = "<!-- carte des services : début (généré par `npm run docs:services`, ne pas modifier à la main) -->";
export const END = "<!-- carte des services : fin -->";

export interface ContractInfo { service: string; type: string; file: string; summary: string; uses: string[] }

/** Contrats déclarés dans `interface Services { nom: Type }` des fichiers donnés (chemins relatifs à la racine). */
export function readContracts(files: string[]): ContractInfo[] {
  const srcs = files.map((f) => ({ file: f, src: readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n") }));
  const all = srcs.map((s) => s.src).join("\n");
  const out: ContractInfo[] = [];
  for (const { file, src } of srcs) {
    for (const block of src.matchAll(/interface Services \{([^}]*)\}/g)) {
      for (const m of block[1]!.matchAll(/^\s+(\w+): (\w+);/gm)) {
        const [, service, type] = m as unknown as [string, string, string];
        const body = extractInterface(all, type) ?? "";
        const doc = /^\/\*\*([\s\S]*?)\*\//.exec(body)?.[1] ?? "";
        const text = doc.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean).join(" ");
        // Première phrase (« ex. » ne la coupe pas).
        const safe = text.replace(/\bex\./g, "ex\u0000");
        const summary = (safe.match(/^.*?[.:](?=\s|$)/)?.[0] ?? safe).replace(/[.:]$/, "").replace(/\u0000/g, ".").trim().replace(/\|/g, "\\|");
        out.push({ service, type, file, summary, uses: [] });
      }
    }
  }
  // Liens entre contrats : le corps d'un contrat cite le type d'un autre service. Un type partagé (brain et
  // delegate sont tous deux des BrainService) compte une fois, sous le premier service qui l'a.
  const ownerOf = new Map<string, string>();
  for (const c of [...out].sort((a, b) => a.service.localeCompare(b.service))) if (!ownerOf.has(c.type)) ownerOf.set(c.type, c.service);
  for (const c of out) {
    const body = (extractInterface(all, c.type) ?? "").replace(/^\/\*\*[\s\S]*?\*\//, "");
    c.uses = [...new Set(out.filter((o) => o.type !== c.type && new RegExp(`\\b${o.type}\\b`).test(body)).map((o) => ownerOf.get(o.type)!))].sort();
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

export function contractFiles(): string[] {
  const dir = join(ROOT, "packages", "contracts", "src");
  return ["packages/core/src/services.ts", ...readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => relative(ROOT, join(dir, f)).replace(/\\/g, "/"))];
}

const id = (prefix: string, s: string) => `${prefix}_${s.replace(/[^A-Za-z0-9]/g, "_")}`;

/** Le bloc Markdown : graphe Mermaid + tableau. */
export function servicesMap(manifests: Manifest[], contracts: ContractInfo[]): string {
  const sig = (m: Manifest) => JSON.stringify([m.provides ?? [], m.inject ?? [], m.optional ?? [], (m.slots ?? []).map((s) => [s.id, s.service])]);
  const linked = manifests.filter((m) => (m.provides?.length || m.inject?.length || m.optional?.length || m.slots?.length));
  const alone = manifests.filter((m) => !linked.includes(m)).map((m) => m.id).sort();
  // Plugins aux mêmes liens : un seul nœud (ex. les huit avatars, les voix cloud).
  const groups = new Map<string, Manifest[]>();
  for (const m of linked) groups.set(sig(m), [...(groups.get(sig(m)) ?? []), m]);
  const services = [...new Set([...contracts.map((c) => c.service), ...linked.flatMap((m) => [...(m.provides ?? []), ...(m.inject ?? []), ...(m.optional ?? []), ...(m.slots ?? []).map((s) => s.service)])])].sort();
  const lines = ["```mermaid", "flowchart LR"];
  lines.push(`  ${id("p", "noyau")}[["noyau (tâches, documents)"]]`);
  for (const s of services) lines.push(`  ${id("s", s)}(["${s}"])`);
  for (const [, ms] of groups) {
    const node = id("p", ms[0]!.id);
    lines.push(`  ${node}["${ms.map((m) => m.id).join("<br/>")}"]`);
    const m = ms[0]!;
    for (const s of m.provides ?? []) lines.push(`  ${node} --> ${id("s", s)}`);
    for (const s of m.inject ?? []) lines.push(`  ${id("s", s)} --> ${node}`);
    for (const s of m.optional ?? []) lines.push(`  ${id("s", s)} -.-> ${node}`);
    for (const sl of m.slots ?? []) lines.push(`  ${id("s", sl.service)} == "${sl.id}" ==> ${node}`);
  }
  lines.push(`  ${id("s", "task")} -.-> ${id("p", "noyau")}`, `  ${id("s", "documents")} -.-> ${id("p", "noyau")}`);
  for (const c of contracts) for (const u of c.uses) lines.push(`  ${id("s", c.service)} -. "type" .- ${id("s", u)}`);
  lines.push("```", "");
  lines.push("Lecture : plugin → service = il le fournit. Service → plugin : trait plein = `inject` (obligatoire), pointillé = `optional`, trait double = un slot (le choix d'un élément, nommé sur la flèche). « type » : un contrat cite le type d'un autre service. Les plugins aux mêmes liens partagent un nœud.", "");
  if (alone.length) lines.push(`Sans service (outils seuls) : ${alone.map((a) => `\`${a}\``).join(", ")}.`, "");
  const who = (pred: (m: Manifest) => boolean) => manifests.filter(pred).map((m) => `\`${m.id}\``).join(", ") || "—";
  lines.push("| Service | Contrat | Ce qu'il fait | Fournisseurs | Utilisé par |", "|---|---|---|---|---|");
  for (const s of services) {
    const c = contracts.find((x) => x.service === s);
    const users = [
      ...manifests.filter((m) => m.inject?.includes(s)).map((m) => `\`${m.id}\``),
      ...manifests.filter((m) => m.optional?.includes(s)).map((m) => `\`${m.id}\` (facultatif)`),
      ...manifests.flatMap((m) => (m.slots ?? []).filter((x) => x.service === s).map((x) => `\`${m.id}\` (slot \`${x.id}\`)`)),
      ...(s === "task" || s === "documents" ? ["noyau"] : []),
    ];
    const contract = c ? `\`${c.type}\` (\`${c.file}\`)${c.uses.length ? ` ; cite ${c.uses.map((u) => `\`${u}\``).join(", ")}` : ""}` : "— (pas de contrat)";
    lines.push(`| \`${s}\` | ${contract} | ${c?.summary || "—"} | ${who((m) => !!m.provides?.includes(s))} | ${users.join(", ") || "—"} |`);
  }
  return lines.join("\n");
}

/** La doc avec le bloc remplacé. */
export function withMap(doc: string, map: string): string {
  const nl = doc.includes("\r\n") ? "\r\n" : "\n";
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${relative(ROOT, DOC)} : marqueurs de la carte des services absents`);
  return doc.slice(0, a + BEGIN.length) + nl + map.replace(/\n/g, nl) + nl + doc.slice(b);
}

export async function generate(): Promise<{ current: string; expected: string }> {
  const { loadCatalog } = await import("./catalog.ts");
  const { plugins } = await loadCatalog({ dev: false });
  const current = readFileSync(DOC, "utf8");
  return { current, expected: withMap(current, servicesMap(plugins.map((p) => p.manifest), readContracts(contractFiles()))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { current, expected } = await generate();
  if (current === expected) console.log("carte des services : déjà à jour");
  else { writeFileSync(DOC, expected); console.log(`carte des services écrite dans ${relative(ROOT, DOC)}`); }
}
