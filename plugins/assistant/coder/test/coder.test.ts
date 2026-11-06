// Tests du plugin coder avec de faux CLI (aucun vrai Claude ni Codex).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, MemoryAudit, type CoderEvent, type CoderService, type CoderAgent, type CoderMode } from "@floppy/core";
import tools from "@floppy/plugin-tools";
import coder, { copyKit } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(here, "fixtures", "fake-claude.mjs");
const fakeCodex = join(here, "fixtures", "fake-codex.mjs");

const home = mkdtempSync(join(tmpdir(), "coder-"));
const pluginsDir = join(home, "plugins");
const audit = new MemoryAudit();
const k = new Kernel({ logger: () => {}, audit, plugins: [tools, coder], home });
const events: CoderEvent[] = [];
let coderSvc: CoderService;
/** Réponse automatique aux validations : true, false, ou "silence". */
let answer: boolean | "silence" = true;
const reached: string[] = [];

beforeAll(async () => {
  await k.applyConfig({
    plugins: [
      { id: "tools", plugin: "tools", config: { port: 0 } },
      { id: "coder", plugin: "coder", config: {
        claudeExe: process.execPath, claudeExeArgs: [fakeClaude],
        codexExe: process.execPath, codexExeArgs: [fakeCodex],
        permission_timeout_s: 1,
      } },
    ],
  });
  k.tools.register("test", [{
    name: "ecrire_note", description: "hors portée", inputSchema: { type: "object", properties: {} }, level: "read",
    handler: async () => { reached.push("ecrire_note"); return { status: "done", text: "ECRIT" }; },
  }]);
  coderSvc = k.service<CoderService>("coder")!;
  coderSvc.onEvent((e) => {
    events.push(e);
    if (e.type === "permission" && answer !== "silence") queueMicrotask(() => coderSvc.answerPermission(e.sessionId, e.id, answer === true));
  });
});
afterAll(() => k.stopAll());

/** Envoie un message et rend les événements du tour, jusqu'à `done`. */
async function turn(sid: string, text: string, timeoutMs = 8000): Promise<CoderEvent[]> {
  const from = events.length;
  coderSvc.send(sid, text);
  const t0 = Date.now();
  for (;;) {
    const mine = events.slice(from).filter((e) => e.sessionId === sid);
    if (mine.some((e) => e.type === "done")) return mine;
    if (Date.now() - t0 > timeoutMs) throw new Error(`délai dépassé : ${JSON.stringify(mine)}`);
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
const textOf = (evs: CoderEvent[]): string => evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
const open = async (agent: CoderAgent, mode: CoderMode): Promise<string> => coderSvc.start({ agent, mode });
const done = (evs: CoderEvent[]) => evs.find((e) => e.type === "done") as Extract<CoderEvent, { type: "done" }>;

describe("coder : Claude", () => {
  it("plugin actif, CLI trouvés, réglages déclarés", async () => {
    expect(k.status().find((s) => s.id === "coder")?.state).toBe("active");
    expect((await coderSvc.agents()).map((a) => [a.id, a.available])).toEqual([["claude", true], ["codex", true]]);
    const keys = k.settings.list().filter((s) => s.section === "assistant").map((s) => s.key);
    expect(keys).toEqual(["assistant_agent", "assistant_modele_claude", "assistant_web"]);
  });

  it("traduit les événements : texte, outils, fin", async () => {
    const sid = await open("claude", "reglages");
    const evs = await turn(sid, "hello");
    expect(textOf(evs)).toBe("Bonjour");
    expect(evs.filter((e) => e.type === "status").map((e) => (e as any).status)).toContain("busy");
    expect(done(evs)).toMatchObject({ stopReason: "end" });

    const t = await turn(sid, "tool");
    const toolEvs = t.filter((e) => e.type === "tool") as Extract<CoderEvent, { type: "tool" }>[];
    expect(toolEvs.map((e) => [e.id, e.name, e.status])).toEqual([
      ["t1", "lister_reglages", "running"], ["t1", "lister_reglages", "done"], ["t2", "Read", "running"], ["t2", "Read", "failed"],
    ]);
    expect(toolEvs[1]!.output).toBe("voix : femme");
    expect(toolEvs[3]!.output).toBe("boum");
    coderSvc.close(sid);
  });

  it("garde un seul processus pour plusieurs tours", async () => {
    const sid = await open("claude", "reglages");
    const a = textOf(await turn(sid, "info"));
    const b = textOf(await turn(sid, "info"));
    const pid = (s: string) => /pid=(\d+)/.exec(s)![1];
    expect(pid(a)).toBe(pid(b));
    expect(a).toContain("tour=1");
    expect(b).toContain("tour=2");
    coderSvc.close(sid);
  });

  it("ligne de commande : réglages (aucun outil intégré, refus du reste) et plugin (outils fichiers + validation)", async () => {
    const r = await open("claude", "reglages");
    const ra = textOf(await turn(r, "info"));
    expect(ra).toContain("--strict-mcp-config");
    // Recherche web permise par défaut (réglage assistant_web) ; aucun autre outil intégré.
    expect(ra).toMatch(/--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch,mcp__floppy__lister_reglages,mcp__floppy__changer_reglage,mcp__floppy__annuler_reglage,mcp__floppy__etat_plugins,mcp__floppy__lister_elements,mcp__floppy__activer_element,mcp__floppy__types_elements,mcp__floppy__ajouter_element/);
    expect(ra).toContain("--permission-mode dontAsk");
    expect(ra).not.toContain("--permission-prompt-tool");
    expect(ra).toContain("--setting-sources project");
    coderSvc.close(r);

    const p = await open("claude", "plugin");
    const pa = textOf(await turn(p, "info"));
    expect(pa).toContain("--tools Read,Edit,Write,Glob,Grep");
    expect(pa).toContain("--allowedTools mcp__floppy__tester_plugin,mcp__floppy__recharger_plugins,mcp__floppy__etat_plugins,mcp__floppy__lister_reglages");
    expect(pa).toContain("--permission-prompt-tool mcp__floppy__permission");
    expect(pa).not.toContain("Bash");
    coderSvc.close(p);
  });

  it("arrêt : tue le tour, puis le message suivant reprend la session (--resume)", async () => {
    const sid = await open("claude", "reglages");
    const first = textOf(await turn(sid, "info"));
    const from = events.length;
    coderSvc.send(sid, "slow");
    while (!events.slice(from).some((e) => e.type === "text")) await new Promise((ok) => setTimeout(ok, 10));
    coderSvc.cancel(sid);
    const cancelled = events.slice(from).filter((e) => e.sessionId === sid).find((e) => e.type === "done");
    expect(cancelled).toMatchObject({ stopReason: "cancelled" });
    const after = textOf(await turn(sid, "info"));
    expect(after).toContain("resume=sess-1");
    expect(after).toContain("tour=1"); // processus neuf
    expect(/pid=(\d+)/.exec(after)![1]).not.toBe(/pid=(\d+)/.exec(first)![1]);
    coderSvc.close(sid);
  });

  it("connexion absente : done avec signIn et un message en français", async () => {
    const sid = await open("claude", "reglages");
    const d = done(await turn(sid, "auth"));
    expect(d).toMatchObject({ stopReason: "error", signIn: true });
    expect(d.error).toContain("claude auth login");
    coderSvc.close(sid);
  });

  it("l'accès MCP de la session ne voit pas les autres outils", async () => {
    const sid = await open("claude", "reglages");
    const t = textOf(await turn(sid, "outside-tool"));
    expect(t).toContain("Outil inconnu");
    expect(reached).not.toContain("ecrire_note");
    coderSvc.close(sid);
  });

  it("trois conversations au maximum", async () => {
    const ids = [await open("claude", "reglages"), await open("claude", "reglages"), await open("claude", "reglages")];
    await expect(open("claude", "reglages")).rejects.toThrow(/Trois conversations/);
    for (const id of ids) coderSvc.close(id);
    const again = await open("claude", "reglages");
    coderSvc.close(again);
  });
});

describe("coder : validation des écritures (mode plugin, Claude)", () => {
  const perm = (tool_name: string, input: Record<string, unknown>) => `perm:${JSON.stringify({ tool_name, input })}`;
  const permEvents = (evs: CoderEvent[]) => evs.filter((e) => e.type === "permission") as Extract<CoderEvent, { type: "permission" }>[];
  let sid: string;
  beforeAll(async () => { sid = await open("claude", "plugin"); });
  afterAll(() => coderSvc.close(sid));

  it("Write accepté : demande avec le contenu, puis feu vert", async () => {
    answer = true;
    const file = join(pluginsDir, "mon-plugin", "index.ts");
    const evs = await turn(sid, perm("Write", { file_path: file, content: "export default {};" }));
    const p = permEvents(evs);
    expect(p).toHaveLength(1);
    expect(p[0]!.diff).toEqual({ path: file, after: "export default {};" });
    expect(textOf(evs)).toBe("autorisé");
  });

  it("Write sur un fichier existant : `before` = contenu actuel", async () => {
    answer = true;
    mkdirSync(join(pluginsDir, "a"), { recursive: true });
    const file = join(pluginsDir, "a", "index.ts");
    writeFileSync(file, "ancien");
    const evs = await turn(sid, perm("Write", { file_path: file, content: "nouveau" }));
    expect(permEvents(evs)[0]!.diff).toEqual({ path: file, before: "ancien", after: "nouveau" });
  });

  it("Edit : avant / après", async () => {
    answer = true;
    const file = join(pluginsDir, "a", "index.ts");
    const evs = await turn(sid, perm("Edit", { file_path: file, old_string: "x", new_string: "y" }));
    expect(permEvents(evs)[0]!.diff).toEqual({ path: file, before: "x", after: "y" });
  });

  it("refus de l'utilisateur", async () => {
    answer = false;
    const evs = await turn(sid, perm("Write", { file_path: join(pluginsDir, "b", "index.ts"), content: "z" }));
    expect(permEvents(evs)).toHaveLength(1);
    expect(textOf(evs)).toContain("refusé");
    expect(textOf(evs)).toContain("L'utilisateur a refusé");
    answer = true;
  });

  it("chemin hors du dossier des plugins : refusé même si l'utilisateur dirait oui, sans même demander", async () => {
    answer = true;
    for (const file of [join(home, "settings.json"), join(pluginsDir, "..", "evil.ts"), join(tmpdir(), "x.ts"), "..\\..\\evil.ts"]) {
      const evs = await turn(sid, perm("Write", { file_path: file, content: "pwn" }));
      expect(permEvents(evs)).toHaveLength(0);
      expect(textOf(evs)).toContain("en dehors du dossier des plugins");
    }
    expect(existsSync(join(home, "evil.ts"))).toBe(false);
  });

  it("Read hors du dossier : refusé ; dans le dossier : libre", async () => {
    expect(textOf(await turn(sid, perm("Read", { file_path: join(home, "settings.json") })))).toContain("refusé");
    const ok = await turn(sid, perm("Read", { file_path: join(pluginsDir, "a", "index.ts") }));
    expect(textOf(ok)).toBe("autorisé");
    expect(permEvents(ok)).toHaveLength(0);
  });

  it("Glob / Grep : chemin ou motif hors du dossier refusés", async () => {
    for (const [tool, input] of [
      ["Glob", { pattern: "/etc/*" }], ["Glob", { pattern: "../**/*.json" }], ["Glob", { pattern: "*", path: home }],
      ["Grep", { pattern: "x", path: home }], ["Grep", { pattern: "x", glob: "..\\..\\*" }],
    ] as const) {
      expect(textOf(await turn(sid, perm(tool, input)))).toContain("refusé");
    }
    expect(textOf(await turn(sid, perm("Grep", { pattern: "../x", path: pluginsDir })))).toBe("autorisé");
    expect(textOf(await turn(sid, perm("Glob", { pattern: "**/*.ts" })))).toBe("autorisé");
  });

  it("outil inconnu (ex. Bash) : refusé sans demander", async () => {
    const evs = await turn(sid, perm("Bash", { command: "dir" }));
    expect(permEvents(evs)).toHaveLength(0);
    expect(textOf(evs)).toContain("refusé");
  });

  it("sans réponse : refus après le délai", async () => {
    answer = "silence";
    const evs = await turn(sid, perm("Write", { file_path: join(pluginsDir, "c", "index.ts"), content: "z" }), 6000);
    expect(permEvents(evs)).toHaveLength(1);
    expect(textOf(evs)).toContain("refusé");
    answer = true;
  });

  it("chaque décision est au journal", () => {
    const decisions = audit.records.filter((r) => r.kind === "coder.permission");
    expect(decisions.some((r) => r.allow === true && r.by === "user")).toBe(true);
    expect(decisions.some((r) => r.allow === false && r.by === "outside")).toBe(true);
    expect(decisions.some((r) => r.allow === false && r.by === "timeout")).toBe(true);
    expect(audit.records.some((r) => r.kind === "coder.session_start")).toBe(true);
    expect(audit.records.some((r) => r.kind === "coder.session_stop")).toBe(true);
  });
});

describe("coder : kit de développement", () => {
  it("copié au premier usage, sans écraser l'existant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-"));
    writeFileSync(join(dir, "AGENTS.md"), "à moi");
    const copied = copyKit(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("à moi");
    expect(copied).not.toContain("AGENTS.md");
    expect(copied.sort()).toEqual(["CLAUDE.md", join("exemple-minuteur", "index.ts"), "floppy-plugin.d.ts"].sort());
    // Deuxième passage : rien à copier ; un fichier modifié reste modifié.
    writeFileSync(join(dir, "floppy-plugin.d.ts"), "modifié");
    expect(copyKit(dir)).toEqual([]);
    expect(readFileSync(join(dir, "floppy-plugin.d.ts"), "utf8")).toBe("modifié");
  });

  it("le mode plugin copie le kit dans <home>/plugins ; AGENTS.md et CLAUDE.md sont identiques", async () => {
    const sid = await open("claude", "plugin");
    for (const f of ["floppy-plugin.d.ts", "AGENTS.md", "CLAUDE.md", join("exemple-minuteur", "index.ts")]) expect(existsSync(join(pluginsDir, f))).toBe(true);
    expect(readFileSync(join(pluginsDir, "AGENTS.md"), "utf8")).toBe(readFileSync(join(pluginsDir, "CLAUDE.md"), "utf8"));
    coderSvc.close(sid);
  });
});

describe("coder : Codex", () => {
  it("réglages : texte, outil MCP, fin", async () => {
    const sid = await open("codex", "reglages");
    const evs = await turn(sid, "bonjour");
    expect(textOf(evs)).toBe("Salut");
    const tl = evs.filter((e) => e.type === "tool") as Extract<CoderEvent, { type: "tool" }>[];
    expect(tl.map((e) => [e.name, e.status])).toEqual([["lister_reglages", "running"], ["lister_reglages", "done"]]);
    expect(done(evs)).toMatchObject({ stopReason: "end" });
    // Deuxième tour sur le même fil.
    expect(textOf(await turn(sid, "encore"))).toBe("Salut");
    coderSvc.close(sid);
  });

  it("plugin : modification acceptée, refusée, et hors dossier (refus d'office)", async () => {
    const sid = await open("codex", "plugin");
    answer = true;
    let evs = await turn(sid, "patch");
    expect(evs.filter((e) => e.type === "permission")).toHaveLength(1);
    expect(textOf(evs)).toBe("decision=accept");
    answer = false;
    evs = await turn(sid, "patch");
    expect(textOf(evs)).toBe("decision=decline");
    answer = true;
    evs = await turn(sid, "patch-outside");
    expect(evs.filter((e) => e.type === "permission")).toHaveLength(0);
    expect(textOf(evs)).toBe("decision=decline");
    coderSvc.close(sid);
  });

  it("connexion absente : signIn avec « codex login »", async () => {
    const sid = await open("codex", "reglages");
    const d = done(await turn(sid, "auth"));
    expect(d).toMatchObject({ stopReason: "error", signIn: true });
    expect(d.error).toContain("codex login");
    coderSvc.close(sid);
  });
});
