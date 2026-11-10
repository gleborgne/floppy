// Wiki des plugins (en anglais) : ce qu'un agent (l'assistant IA des réglages, mode « Créer un plugin ») doit savoir
// pour écrire un plugin, servi par un outil de lecture (`plugin_docs`). Pourquoi un outil plutôt que des fichiers copiés :
// - les pages suivent la version de Floppy (le kit copié dans <home>/plugins n'est jamais écrasé) ;
// - certaines pages sont calculées maintenant : services qui tournent, outils existants ;
// - les contrats des services sont lus dans leur code (packages/core/src/services.ts, packages/contracts/src) : jamais en retard ;
// - le même outil marche pour Claude Code et Codex (serveur MCP de Floppy).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kernel, Manifest, ToolDef } from "@floppy/core";

/** Pages écrites à la main (packages/sdk/wiki/*.md), dans l'ordre de lecture conseillé. */
export const WIKI_DIR = dirname(fileURLToPath(import.meta.resolve("@floppy/sdk/wiki/basics.md")));
const EXAMPLES_DIR = dirname(dirname(fileURLToPath(import.meta.resolve("@floppy/sdk/examples/minuteur/index.ts"))));
/** Sources des contrats : ceux du noyau (tâches, documents) et ceux des domaines (@floppy/contracts). */
const CONTRACTS_DIR = dirname(fileURLToPath(import.meta.resolve("@floppy/contracts")));
const SERVICES_SRC = [fileURLToPath(new URL("./services.ts", import.meta.resolve("@floppy/core"))),
  ...readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".ts")).map((f) => join(CONTRACTS_DIR, f))];
const ORDER = ["basics", "tools", "settings", "languages", "events", "services", "security", "testing"];

/** Services qu'un plugin personnel peut utiliser, et les interfaces du noyau qui forment leur contrat. */
export const CONTRACTS: Record<string, string[]> = {
  notify: ["NotifyMessage", "NotifyService"],
  completion: ["CompletionRequest", "CompletionService"],
  search: ["SearchHit", "SearchService"],
  documents: ["DocRef", "DocumentsService"],
};

export interface WikiPage {
  id: string;
  title: string;
  summary: string;
}

export interface WikiOptions {
  kernel: Kernel;
  /** Manifestes des plugins livrés (qui fournit quel service). */
  manifests: () => Manifest[];
  /** Tests : autres dossiers. */
  wikiDir?: string;
  examplesDir?: string;
  servicesSrc?: string[];
}

/** Bloc `export interface <name> {…}` du source, avec le commentaire juste au-dessus. undefined : absent. */
export function extractInterface(src: string, name: string): string | undefined {
  const m = new RegExp(`^export interface ${name}\\b`, "m").exec(src);
  if (!m) return undefined;
  let start = m.index;
  const c = src.lastIndexOf("/**", start);
  if (c >= 0) {
    const end = src.indexOf("*/", c);
    if (end >= 0 && end < start && src.slice(end + 2, start).trim() === "") start = c;
  }
  let depth = 0;
  for (let i = src.indexOf("{", m.index); i >= 0 && i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return undefined;
}

export function createWiki(o: WikiOptions) {
  const wikiDir = o.wikiDir ?? WIKI_DIR;
  const examplesDir = o.examplesDir ?? EXAMPLES_DIR;
  const servicesSrc = o.servicesSrc ?? SERVICES_SRC;

  const staticPages = (): (WikiPage & { file: string })[] => {
    const files = existsSync(wikiDir) ? readdirSync(wikiDir).filter((f) => f.endsWith(".md")) : [];
    const rank = (id: string) => { const i = ORDER.indexOf(id); return i < 0 ? ORDER.length : i; };
    return files.map((f) => {
      const id = f.slice(0, -3);
      const lines = readFileSync(join(wikiDir, f), "utf8").split(/\r?\n/);
      return {
        id, file: join(wikiDir, f),
        title: (lines.find((l) => l.startsWith("# ")) ?? id).replace(/^#\s*/, ""),
        summary: (lines.find((l) => l.startsWith("> ")) ?? "").replace(/^>\s*/, ""),
      };
    }).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  };

  const examples = (): string[] =>
    existsSync(examplesDir) ? readdirSync(examplesDir).filter((d) => statSync(join(examplesDir, d)).isDirectory()).sort() : [];

  const pages = (): WikiPage[] => [
    ...staticPages().map(({ file: _f, ...p }) => p),
    ...Object.keys(CONTRACTS).map((s) => ({ id: `contract-${s}`, title: `Contract of the ${s} service`, summary: "Exact interface, read from the kernel source." })),
    { id: "active-services", title: "Active services", summary: "Who provides notify, completion, search, documents right now." },
    { id: "existing-tools", title: "Existing tools", summary: "Names and levels of the tools already there (do not duplicate one)." },
    ...examples().map((e) => ({ id: `example-${e}`, title: `Example: ${e}`, summary: "Full code of an example plugin." })),
  ];

  const contract = (service: string): string | undefined => {
    const names = CONTRACTS[service];
    if (!names) return undefined;
    const src = servicesSrc.map((f) => readFileSync(f, "utf8")).join("\n");
    const blocks = names.map((n) => extractInterface(src, n) ?? `// ${n}: not found in the kernel`);
    return [
      `# Contract of the ${service} service`,
      `Declare "${service}" in manifest.optional (or inject), then read the services page to get it.`,
      "The types are also in floppy-plugin.d.ts (Services). Comments and field names are in French: keep the names as they are.",
      "",
      "```ts",
      blocks.join("\n\n"),
      "```",
    ].join("\n");
  };

  const activeServices = (): string => {
    const status = o.kernel.status();
    const byPlugin = new Map(o.manifests().map((m) => [m.id, m]));
    const lines = Object.keys(CONTRACTS).map((s) => {
      const who = status.filter((e) => !e.fork && (byPlugin.get(e.plugin)?.provides ?? e.provides).includes(s));
      const list = who.map((e) => `${e.id} (${e.state})`).join(", ");
      return `- ${s}: ${list || "no installed plugin provides it"}`;
    });
    return [
      "# Active services",
      "Plugins that provide each service (entry and state). \"active\" = usable now.",
      "The items themselves (each Telegram channel, each model) are listed inside the plugin with ctx.offers(service).",
      "",
      ...lines,
    ].join("\n");
  };

  const existingTools = (): string => {
    const tools = o.kernel.tools.list();
    return ["# Existing tools", `${tools.length} tools. Prefix your tools with your plugin id.`, "",
      ...tools.map((t) => `- ${t.name} [${t.level}]`).sort()].join("\n");
  };

  const example = (name: string): string | undefined => {
    if (!examples().includes(name)) return undefined;
    const dir = join(examplesDir, name);
    const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort((a, b) => (a === "index.ts" ? -1 : b === "index.ts" ? 1 : a.localeCompare(b)));
    const out = [`# Example: ${name}`,
      "Third-party example plugin (floppy-plugin.json). For a personal plugin: same index.ts, no floppy-plugin.json, import type from \"../floppy-plugin.d.ts\"."];
    for (const f of files) out.push("", `## ${f}`, "```" + (f.endsWith(".json") ? "json" : "ts"), readFileSync(join(dir, f), "utf8").trimEnd(), "```");
    return out.join("\n");
  };

  /** Contenu d'une page, ou undefined si elle n'existe pas. */
  const read = (id: string): string | undefined => {
    const key = id.trim().toLowerCase().replace(/\.md$/, "");
    const st = staticPages().find((p) => p.id === key);
    if (st) return readFileSync(st.file, "utf8");
    if (key.startsWith("contract-")) return contract(key.slice("contract-".length));
    if (key === "active-services") return activeServices();
    if (key === "existing-tools") return existingTools();
    if (key.startsWith("example-")) return example(key.slice("example-".length));
    return undefined;
  };

  const index = (): string => [
    "# Floppy plugin wiki",
    "Read \"basics\" first, then the pages your task needs. Call plugin_docs with { page: \"<id>\" }.",
    "",
    ...pages().map((p) => `- ${p.id}: ${p.title}${p.summary ? " — " + p.summary : ""}`),
  ].join("\n");

  /** Lignes qui contiennent tous les mots de la recherche, avec leur page (pages écrites et contrats). */
  const search = (q: string): string => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return index();
    const hits: string[] = [];
    const ids = [...staticPages().map((p) => p.id), ...Object.keys(CONTRACTS).map((s) => `contract-${s}`)];
    for (const id of ids) {
      const lines = (read(id) ?? "").split(/\r?\n/);
      lines.forEach((l, i) => { const low = l.toLowerCase(); if (words.every((w) => low.includes(w))) hits.push(`${id}:${i + 1}: ${l.trim().slice(0, 200)}`); });
    }
    return hits.length
      ? [`${hits.length} result(s) for "${q}":`, ...hits.slice(0, 40)].join("\n")
      : `Nothing for "${q}". Pages: ${pages().map((p) => p.id).join(", ")}.`;
  };

  const tool: ToolDef = {
    name: "plugin_docs",
    description: "Wiki (en anglais) pour écrire un plugin Floppy : sans argument, le sommaire ; { page } pour lire une page (basics, tools, settings, services, contract-notify…, active-services, existing-tools, example-…) ; { search } pour chercher des mots.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "id de la page (voir le sommaire)" },
        search: { type: "string", description: "mots à chercher dans les pages" },
      },
    },
    level: "read",
    async handler(args) {
      if (typeof args.search === "string" && args.search.trim()) return { status: "done", text: search(args.search) };
      if (typeof args.page === "string" && args.page.trim()) {
        const text = read(args.page);
        return text === undefined
          ? { status: "failed", text: `Unknown page: "${args.page}". Pages: ${pages().map((p) => p.id).join(", ")}.` }
          : { status: "done", text };
      }
      return { status: "done", text: index() };
    },
  };

  return { pages, read, index, search, tool };
}
