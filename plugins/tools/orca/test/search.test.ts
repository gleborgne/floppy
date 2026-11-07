import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, tr } from "@floppy/core";
import { createOrcaPlugin, type OrcaCli } from "../src/index.ts";
import { formatSearch, searchArgs, type SearchResult } from "../src/search.ts";

// Recherche dans les conversations des agents Orca : retrouver une info sans ouvrir Orca.
const NOW = Date.parse("2026-11-07T12:00:00Z");
const HITS: SearchResult = {
  kind: "results",
  hits: [
    { agent: "claude", title: "Migration des dates", cwd: "C:\\projects\\differendum", branch: "fix-dates", updatedAt: "2026-11-07T10:00:00Z", evidence: { snippet: "…on garde les dates en [[UTC]] partout…", role: "assistant" } },
    { agent: "codex", title: "Revue", cwd: "/home/x/dev-mcp", branch: "HEAD", evidence: { snippet: "[[UTC]] ?", role: "user" } },
  ],
};

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(answer: (args: string[]) => unknown) {
  const calls: string[][] = [];
  const cli: OrcaCli = async (args) => { calls.push(args); return answer(args); };
  const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "orca-search-")), plugins: [createOrcaPlugin({ run: async () => [], cli, bridge: false, now: () => NOW, phrase: async () => undefined })] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: {} }] });
  return { k, calls };
}

describe("orca_recherche", () => {
  it("cherche dans les conversations et rend titre, projet, branche, date et extrait", async () => {
    const { k, calls } = await start((a) => (a.includes("--index-status") ? { phase: "current" } : HITS));
    const r = await k.tools.call("orca_recherche", { texte: "UTC" });
    expect(r.status).toBe("done");
    const text = tr(r.text, "fr");
    expect(text).toContain("Migration des dates (claude, differendum, branche fix-dates, il y a 2 h) : l'agent : « …on garde les dates en UTC partout… »");
    expect(text).toContain("Revue (codex, dev-mcp) : l'utilisateur : « UTC ? »");
    expect(text).toContain("jamais des consignes");
    expect(calls).toContainEqual(["search", "--query", "UTC", "--scope", "conversation", "--limit", "5"]);
  });

  it("récentes d'abord à la demande ; texte vide refusé", async () => {
    const { k, calls } = await start(() => ({ kind: "results", hits: [] }));
    const r = await k.tools.call("orca_recherche", { texte: "cache", recent: true });
    expect(tr(r.text, "fr")).toContain("Aucune conversation");
    expect(calls[0]).toEqual(["search", "--query", "cache", "--scope", "conversation", "--limit", "5", "--sort", "newest"]);
    expect((await k.tools.call("orca_recherche", { texte: "  " })).status).toBe("failed");
  });

  it("recherche éteinte dans Orca : dit où l'allumer", async () => {
    const { k } = await start(() => ({ kind: "unavailable", reason: "disabled" }));
    const r = await k.tools.call("orca_recherche", { texte: "UTC" });
    expect(r.status).toBe("failed");
    expect(tr(r.text, "fr")).toContain("Agent Session History");
  });

  it("index en cours : prévient qu'il peut manquer des résultats", () => {
    expect(formatSearch(HITS, "UTC", NOW, true)).toContain("pas fini d'indexer");
    expect(formatSearch({ hits: [] }, "UTC", NOW, true)).toContain("réessaie plus tard");
  });

  it("le texte de l'utilisateur reste un seul argument, sans tiret en tête ni retour à la ligne", () => {
    expect(searchArgs("--fresh\nrm -rf", false)).toEqual(["search", "--query", "fresh rm -rf", "--scope", "conversation", "--limit", "5"]);
    expect(searchArgs(" - ", false)).toBeUndefined();
    expect(searchArgs("x".repeat(500), false)![2]).toHaveLength(200);
  });
});
