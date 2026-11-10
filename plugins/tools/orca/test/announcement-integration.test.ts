import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Kernel, definePlugin } from "@floppy/core";
import type { AgentTrackingService, CompletionRequest } from "@floppy/contracts";
import { createOrcaPlugin, type OrcaWorktree } from "../src/index.ts";

describe("annonces Orca avec modèle emprunté", () => {
  it.each(["fr", "en"] as const)("résume le terminal exact et annonce les suites attendues (%s)", async (language) => {
    const calls: string[][] = [];
    const requests: CompletionRequest[] = [];
    const response = language === "fr"
      ? "Migration : l’agent a corrigé les dates et les tests passent. Il attend votre validation avant publication."
      : "Migration: the agent fixed the dates and the tests pass. It needs your approval before publishing.";
    const model = definePlugin({ manifest: { id: "summary-test", version: "0", licence: "MIT", provides: ["completion"] }, apply(c) {
      c.offer("completion", { items: () => [{ id: "model", label: "Modèle" }], start(f) {
        f.provide("completion", { async complete(req) { requests.push(req); return { text: response }; } });
      } });
    } });
    const rows: OrcaWorktree[] = [{ worktreeId: "workspace", repo: "Floppy", agents: [{ paneKey: "tab:pane", state: "working", taskTitle: "Migration", prompt: "Corrige les dates" }] }];
    const cli = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree") return { worktrees: structuredClone(rows) };
      if (args[1] === "list") return { terminals: [
        { handle: "term_wrong", worktreeId: "elsewhere", tabId: "tab", leafId: "pane" },
        { handle: "term_exact", worktreeId: "workspace", tabId: "tab", leafId: "pane" },
      ] };
      if (args[1] === "read") return { terminal: { tail: ["J'ai corrigé les dates. Les tests passent. Validez le résultat avant publication."] } };
      throw new Error("commande inattendue");
    };
    const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "orca-summary-")), logger: () => {}, plugins: [model, createOrcaPlugin({ cli, bridge: false })] });
    const announcements: string[] = [];
    k.bus.on("initiative", (e) => announcements.push(e.text));
    try {
      await k.applyConfig({ assistant: { language }, slots: { "orca.summary": "model/model" }, plugins: [
        { id: "model", plugin: "summary-test" }, { id: "orca", plugin: "orca", config: { pollSeconds: 600 } },
      ] });
      const tracking = k.service<AgentTrackingService>("agentTracking")!;
      await tracking.refresh();
      expect(requests).toHaveLength(0);
      rows[0]!.agents![0]!.state = "done";
      await tracking.refresh();
      await vi.waitFor(() => expect(announcements).toHaveLength(1));
      expect(calls.filter((args) => args[1] === "read")).toEqual([["terminal", "read", "--terminal", "term_exact", "--screen", "--limit", "60"]]);
      expect(requests[0]!.prompt).toContain("Validez le résultat avant publication");
      expect(announcements).toEqual([response]);
      expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
      await vi.waitFor(() => expect(k.status().filter((entry) => entry.fork?.service === "completion")).toHaveLength(0));
    } finally { await k.stopAll(); }
  });
});
