// Relecture des plugins tiers : un tour unique, sans outil, avec de faux CLI.
import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewArgs, runReview } from "../src/review.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-review.mjs");
const run = (agent: "claude" | "codex" | "agy", prompt: string) => runReview({ agent, exe: process.execPath, exeArgs: [fake], prompt, timeoutMs: 10_000, spawn: (c, a, o) => spawn(c, a, o ?? {}) });

describe("relecture d'un plugin tiers", () => {
  it("Claude : aucun outil, aucune config MCP de l'utilisateur", async () => {
    expect(reviewArgs("claude", "sonnet", "x")).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--permission-mode", "dontAsk"]));
    const r = JSON.parse(await run("claude", "abc"));
    expect(r).toMatchObject({ verdict: "ok", summary: "lu 3 caractères" });
  });

  it("Codex : bac à sable en lecture seule, réponse lue dans le fichier -o", async () => {
    const r = JSON.parse(await run("codex", "abcd"));
    expect(r.summary).toBe("lu 4 caractères");
    expect(r.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  it("Antigravity : flux JSON, consigne de relecture en tête", async () => {
    const r = JSON.parse(await run("agy", "abcde"));
    expect(r.verdict).toBe("ok");
    expect(Number(r.summary.match(/\d+/)[0])).toBeGreaterThan(5);
  });

  it("une erreur du CLI devient une erreur lisible", async () => {
    await expect(run("claude", "ÉCHEC")).rejects.toThrow(/quota/);
  });
});
