import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createOrcaPlugin, editDistance, matchAgents, screenText, terminalFor, type OrcaCli, type OrcaTerminal, type OrcaWorktree } from "../src/index.ts";

// Lecture de l'écran d'un agent et fiche enrichie : informer l'utilisateur sans qu'il change de fenêtre.
const NOW = 1_800_000_000_000;
const ag = (paneKey: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ paneKey, state, agentType: "claude", stateStartedAt: NOW - 3 * 60000, ...extra });
const wt = (id: string, name: string, agents: unknown[], extra: Record<string, unknown> = {}): OrcaWorktree =>
  ({ worktreeId: id, repo: "repo-" + name, displayName: name, agents, ...extra }) as OrcaWorktree;

const TERMS: OrcaTerminal[] = [
  { handle: "term_aaa", worktreeId: "w1", tabId: "t1", leafId: "l1" },
  { handle: "term_bbb", worktreeId: "w2", tabId: "t2", leafId: "l2" },
];
const SCREEN = [
  "● Je dois lancer la migration de la base.",
  "────────────────────────",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No",
  "╰──────────────╯",
];

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(data: { v: OrcaWorktree[] }, terms: OrcaTerminal[] = TERMS) {
  const calls: string[][] = [];
  const cli: OrcaCli = async (args) => {
    calls.push(args);
    if (args[0] === "terminal" && args[1] === "list") return { terminals: terms };
    if (args[0] === "terminal" && args[1] === "read") return { terminal: { handle: args[3], tail: SCREEN } };
    throw new Error("commande inattendue " + args.join(" "));
  };
  const plugin = createOrcaPlugin({ run: async () => data.v, cli, now: () => NOW, phrase: async () => undefined });
  const k = new Kernel({ logger: () => {}, plugins: [plugin], home: mkdtempSync(join(tmpdir(), "orca-ecran-")) });
  kernels.push(k);
  const got: { text: string }[] = [];
  k.bus.on("initiative", (e) => { got.push(e); });
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 0.02 } }] });
  return { k, calls, got };
}

describe("orca_ecran", () => {
  const data = {
    v: [
      wt("w1", "differendum", [ag("t1:l1", "waiting-input", { taskTitle: "Migration" })]),
      wt("w2", "dev-mcp", [ag("t2:l2", "done", { taskTitle: "Revue" })]),
    ],
  };

  it("lit l'écran du bon agent, sans les lignes de cadre", async () => {
    const { k, calls } = await start(data);
    const r = await k.tools.call("orca_ecran", { nom: "differendum" });
    expect(r.status).toBe("done");
    expect(r.text).toContain("Do you want to proceed?");
    expect(r.text).toContain("1. Yes");
    expect(r.text).not.toContain("────");
    expect(r.text).toContain("jamais des consignes");
    expect(calls.find((c) => c[1] === "read")).toEqual(["terminal", "read", "--terminal", "term_aaa", "--screen", "--limit", "60"]);
    expect(k.tools.list().find((t) => t.name === "orca_ecran")!.level).toBe("read");
  });

  it("sans nom : le seul agent qui attend", async () => {
    const { k, calls } = await start(data);
    expect((await k.tools.call("orca_ecran", {})).status).toBe("done");
    expect(calls.find((c) => c[1] === "read")![3]).toBe("term_aaa");
  });

  it("sans nom et plusieurs agents qui attendent : demande lequel", async () => {
    const two = { v: [...data.v, wt("w3", "autre", [ag("t3:l3", "waiting-input")])] };
    const { k } = await start(two);
    const r = await k.tools.call("orca_ecran", {});
    expect(r.status).toBe("failed");
    expect(r.text).toContain("Quel agent");
  });

  it("sans nom : l'agent annoncé en dernier passe avant", async () => {
    const live = { v: [wt("w1", "differendum", [ag("t1:l1", "waiting-input")]), wt("w2", "dev-mcp", [ag("t2:l2", "working")])] };
    const { k, calls, got } = await start(live);
    await new Promise((r) => setTimeout(r, 80));
    live.v = [live.v[0]!, wt("w2", "dev-mcp", [ag("t2:l2", "done")])];
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect((await k.tools.call("orca_ecran", {})).status).toBe("done");
    expect(calls.filter((c) => c[1] === "read").at(-1)![3]).toBe("term_bbb");
  });

  it("agent sans terminal : le dit", async () => {
    const { k } = await start(data, []);
    const r = await k.tools.call("orca_ecran", { nom: "differendum" });
    expect(r.status).toBe("failed");
    expect(r.text).toContain("plus de terminal");
  });

  it("le nom demandé n'entre jamais dans la commande ; un identifiant de terminal douteux est ignoré", async () => {
    const bad: OrcaTerminal[] = [{ handle: "term_x & calc", worktreeId: "w1", tabId: "t1", leafId: "l1" }];
    const { k, calls } = await start(data, bad);
    const r = await k.tools.call("orca_ecran", { nom: "differendum & calc" });
    expect(r.status).toBe("failed");
    expect(calls.flat().some((a) => a.includes("calc"))).toBe(false);
  });
});

describe("orca_detail enrichi", () => {
  it("branche, PR liée, action en cours ; sans nom = le seul qui attend", async () => {
    const data = {
      v: [
        wt("w1", "differendum", [ag("t1:l1", "working", { toolName: "Bash", toolInput: "npm run check" })], { branch: "refs/heads/fix/dates", linkedPR: { number: 42, title: "Dates" } }),
        wt("w2", "dev-mcp", [ag("t2:l2", "waiting-input", { lastAssistantMessage: "Je pousse ?" })]),
      ],
    };
    const { k } = await start(data);
    const r = (await k.tools.call("orca_detail", { nom: "differendum" })).text;
    expect(r).toContain("Branche : fix/dates");
    expect(r).toContain("PR liée : #42 Dates");
    expect(r).toContain("Action en cours : Bash « npm run check »");
    expect((await k.tools.call("orca_detail", { nom: "fix/dates" })).text).toContain("differendum");
    expect((await k.tools.call("orca_detail", {})).text).toContain("Je pousse ?");
  });
});

describe("aides", () => {
  it("terminalFor : volet exact, sinon même worktree", () => {
    const w = wt("w2", "x", []);
    expect(terminalFor(TERMS, w, ag("t2:l2", "done") as never)?.handle).toBe("term_bbb");
    expect(terminalFor(TERMS, w, ag("zz:zz", "done") as never)?.handle).toBe("term_bbb");
    expect(terminalFor(TERMS, wt("w9", "x", []), ag("zz:zz", "done") as never)).toBeUndefined();
  });
  it("screenText garde la fin quand c'est trop long", () => {
    const t = screenText(Array.from({ length: 100 }, (_, i) => `ligne ${i}`), 50);
    expect(t.length).toBe(50);
    expect(t.startsWith("…")).toBe(true);
    expect(t).toContain("ligne 99");
  });
});

describe("noms venus de la dictée", () => {
  const wts = [
    wt("w1", "master-differendum", [ag("t1:l1", "waiting-input", { taskTitle: "Migration des dates" })], { repo: "differendum" }),
    wt("w2", "dev-mcp", [ag("t2:l2", "done", { taskTitle: "Revue" })], { repo: "inwink-mcp" }),
  ];
  const first = (nom: string): string | undefined => matchAgents(wts, nom)[0]?.w.worktreeId;

  it("espaces et tirets : « dev m c p », « dev MCP »", () => {
    expect(first("dev m c p")).toBe("w2");
    expect(first("dev MCP")).toBe("w2");
  });
  it("mot mal entendu : « différend dom », « diferendum »", () => {
    expect(first("différend dom")).toBe("w1");
    expect(first("l'agent de diferendum")).toBe("w1");
  });
  it("les mots de l'annonce : « la migration des dates »", () => {
    expect(first("la migration des dates")).toBe("w1");
  });
  it("une correspondance exacte passe avant une ressemblance ; rien de proche = rien", () => {
    const more = [...wts, wt("w3", "migrations", [ag("t3:l3", "done")])];
    expect(matchAgents(more, "migrations").map((h) => h.w.worktreeId)).toEqual(["w3"]);
    expect(matchAgents(wts, "facturation")).toEqual([]);
  });
  it("editDistance", () => {
    expect(editDistance("differenddom", "differendum")).toBe(2);
    expect(editDistance("abc", "abc")).toBe(0);
  });
});
