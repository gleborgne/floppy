import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createOrcaPlugin, type OrcaCli, type OrcaWorktree } from "../src/index.ts";

const NOW = 1_800_000_000_000;
const ag = (paneKey: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ paneKey, state, agentType: "claude", stateStartedAt: NOW - 5 * 60000, ...extra });
const wt = (id: string, name: string, agents: unknown[], extra: Record<string, unknown> = {}): OrcaWorktree =>
  ({ worktreeId: id, repo: "repo-" + name, displayName: name, status: "active", agents, ...extra }) as OrcaWorktree;

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(data: { v: OrcaWorktree[]; fail?: boolean; calls: number }, config: Record<string, unknown> = {}, cli?: OrcaCli) {
  const plugin = createOrcaPlugin({ run: async () => { data.calls++; if (data.fail) throw new Error("hors ligne"); return data.v; }, now: () => NOW, ...(cli ? { cli } : {}), phrase: async () => undefined });
  const k = new Kernel({ logger: () => {}, plugins: [plugin], home: mkdtempSync(join(tmpdir(), "orca-")) });
  kernels.push(k);
  const got: { text: string; importance: string; key?: string }[] = [];
  k.bus.on("initiative", (e) => { got.push(e); });
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 0.02, ...config } }] });
  return { k, got };
}

describe("outils", () => {
  const data = {
    calls: 0,
    v: [
      wt("w1", "dev-mcp", [
        ag("p1", "working", { taskTitle: "Migration", lastAssistantMessage: "x".repeat(300) }),
        ag("p2", "done", { conversationName: "Revue" }),
      ], { comment: "chantier" }),
      wt("w2", "Évaluation", [ag("p3", "waiting-input", { prompt: "fais le truc", lastAssistantMessage: "Quelle option ?" })]),
      wt("w3", "vide", []),
    ],
  };

  it("orca_agents : filtres et format", async () => {
    const { k } = await start(data, { surveillance: false });
    const all = (await k.tools.call("orca_agents", {})).text;
    expect(all).toContain("dev-mcp");
    expect(all).toContain("chantier");
    expect(all).toContain("Claude en cours depuis 5 min : Migration");
    expect(all).not.toContain("vide");
    expect(all).not.toContain("x".repeat(141));
    expect(all.length).toBeLessThanOrEqual(1520);
    const run = (await k.tools.call("orca_agents", { filtre: "en_cours" })).text;
    expect(run).toContain("Migration");
    expect(run).not.toContain("Revue");
    expect((await k.tools.call("orca_agents", { filtre: "termines" })).text).toContain("Revue");
    const wait = (await k.tools.call("orca_agents", { filtre: "en_attente" })).text;
    expect(wait).toContain("en attente");
    expect(wait).not.toContain("Migration");
  });

  it("orca_detail : recherche floue sans accents", async () => {
    const { k } = await start(data, { surveillance: false });
    const r = (await k.tools.call("orca_detail", { nom: "EVALUATION" })).text;
    expect(r).toContain("Quelle option ?");
    expect(r).toContain("fais le truc");
    expect((await k.tools.call("orca_detail", { nom: "migrat" })).text).toContain("dev-mcp");
    expect((await k.tools.call("orca_detail", { nom: "zzz" })).text).toContain("Aucun agent");
  });
});

describe("surveillance", () => {
  const mk = (state: string, extra = {}) => [wt("w1", "dev-mcp", [ag("p1", state, { taskTitle: "Migration", ...extra })])];

  it("rien au premier relevé, une seule initiative à la fin", async () => {
    const data = { calls: 0, v: mk("done") };
    const { got } = await start(data);
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(2));
    expect(got).toEqual([]);
    data.v = mk("working");
    const n = data.calls;
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(n + 1));
    data.v = mk("done");
    await vi.waitFor(() => expect(got.length).toBe(1));
    const n2 = data.calls;
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(n2 + 3));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ source: "orca", importance: "normal", key: "orca:w1:p1:termines" });
    expect(got[0]!.text).toBe("Sur Repo dev mcp, ton agent a fini : migration.");
  });

  it("importance selon le réglage", async () => {
    for (const [notif, state, imp] of [["importantes", "waiting-input", "important"], ["toutes", "done", "important"], ["importantes", "done", "normal"]] as const) {
      const data = { calls: 0, v: mk("working") };
      const { got } = await start(data, { notifications: notif });
      await vi.waitFor(() => expect(data.calls).toBeGreaterThan(1));
      data.v = mk(state);
      await vi.waitFor(() => expect(got.length).toBe(1));
      expect(got[0]!.importance).toBe(imp);
    }
  });

  it("rien : pas d'initiative, Orca n'est plus surveillé ; l'ancien « surveillance : non » vaut « rien »", async () => {
    for (const cfg of [{ notifications: "aucune" }, { surveillance: false }]) {
      const data = { calls: 0, v: mk("working") };
      const { k, got } = await start(data, cfg);
      data.v = mk("done");
      await new Promise((r) => setTimeout(r, 120));
      expect(data.calls).toBe(0);
      expect(got).toEqual([]);
      expect(k.settings.list().find((x) => x.key === "orca_notifications")!.value).toBe("aucune");
      expect(JSON.stringify((await k.items.provider("apps-connecteurs")!.list()).find((i) => i.kind === "orca")!.statusText)).toContain("annonces coupées");
    }
  });

  it("surveillance coupée : plus d'appels", async () => {
    const data = { calls: 0, v: mk("working") };
    const { k } = await start(data);
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(1));
    expect((await k.settings.change("orca_notifications", "rien", "cli")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    const n = data.calls;
    await new Promise((r) => setTimeout(r, 120));
    expect(data.calls).toBe(n);
  });

  it("Orca hors ligne : on continue sans planter", async () => {
    const data = { calls: 0, v: [] as OrcaWorktree[], fail: true };
    const { k } = await start(data);
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(3));
    expect(k.status()[0]?.state).toBe("active");
    expect((await k.tools.call("orca_agents", {})).status).toBe("failed");
  });
});

describe("Orca est une application (ajoutée ou retirée par l'utilisateur)", () => {
  const mk = (state: string) => [wt("w1", "dev-mcp", [ag("p1", state, { taskTitle: "Migration" })])];
  const P = "apps-connecteurs";
  const orca = async (k: Kernel) => (await k.items.provider(P)!.list()).find((i) => i.kind === "orca")!;

  it("un élément avec ses outils ; éteint = entrée arrêtée (outils retirés, surveillance coupée) ; retiré puis rajouté", async () => {
    const data = { calls: 0, v: mk("working") };
    const { k } = await start(data);
    expect(k.items.provider(P)!.kinds!.map((x) => x.id)).toContain("orca");
    const it = await orca(k);
    expect(it).toMatchObject({ id: "orca", enabled: true, status: "ok", removable: true });
    // Ses réglages sont montrés dans l'élément (« Configurer »), pas dans la rubrique.
    expect(it.settings).toEqual(["orca_notifications"]);
    expect(it.children!.map((c) => c.id)).toEqual(["orca_agents", "orca_detail", "orca_ecran", "orca_recherche"]);
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(1));

    expect((await k.items.run({ op: "enable", provider: P, id: "orca", on: false }, "cli")).ok).toBe(true);
    expect(k.tools.list().some((t) => t.name.startsWith("orca_"))).toBe(false);
    expect(await orca(k)).toMatchObject({ enabled: false, status: "off" });
    expect((await orca(k)).children!.length).toBe(4);
    const n = data.calls;
    await new Promise((r) => setTimeout(r, 120));
    expect(data.calls).toBe(n);

    await k.items.run({ op: "enable", provider: P, id: "orca", on: true }, "cli");
    expect(k.tools.list().some((t) => t.name === "orca_agents")).toBe(true);

    expect((await k.items.run({ op: "remove", provider: P, id: "orca" }, "cli")).ok).toBe(true);
    expect(k.status().some((s) => s.id === "orca")).toBe(false);
    const r = await k.items.run({ op: "add", provider: P, kind: "orca", values: { pollSeconds: 0.02 } }, "cli");
    expect(r.ok).toBe(true);
    expect(k.tools.list().some((t) => t.name === "orca_agents")).toBe(true);
    expect((await k.items.run({ op: "add", provider: P, kind: "orca", values: {} }, "cli")).ok).toBe(false);
  });

  it("décocher un outil le cache au cerveau ; les réglages sont dans la rubrique connecteurs", async () => {
    const { k } = await start({ calls: 0, v: [] }, { surveillance: false });
    await k.items.run({ op: "child", provider: P, id: "orca", child: "orca_detail", on: false }, "cli");
    expect(k.tools.list().some((t) => t.name === "orca_detail")).toBe(false);
    expect((await k.tools.call("orca_detail", { nom: "x" })).status).toBe("failed");
    expect(k.tools.list().some((t) => t.name === "orca_agents")).toBe(true);
    for (const key of ["orca_notifications"]) {
      const s = k.settings.list().find((x) => x.key === key)!;
      expect(s.section).toBe("connecteurs");
      expect(typeof s.label).toBe("object");
    }
  });

  it("ajouter à la voix demande l'accord ; « installe Orca » quand Orca est déjà là ne l'ajoute pas deux fois", async () => {
    const { k } = await start({ calls: 0, v: [] }, { surveillance: false });
    const asked: string[] = [];
    k.bus.on("approval.request", (r) => { asked.push(String(r.summary)); k.approvals.respond(r.id, false, "test"); });
    expect((await k.items.run({ op: "add", provider: P, kind: "orca", values: {} }, "voice")).ok).toBe(false);
    expect(asked).toEqual(["Ajouter Orca"]);
    expect((await k.tools.call("ajouter_application", { nom: "orca" })).text).toMatch(/déjà ajouté/);
    expect(asked.length).toBe(1);
  });
});
