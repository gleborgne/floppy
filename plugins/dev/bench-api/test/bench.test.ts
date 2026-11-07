// Banc : JSON invalide = 400 ; auto-réponse aux accords seulement pour les tours de la requête.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainService } from "@floppy/contracts";
import bench from "../src/index.ts";

let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); });

const PORT = 18741 + Math.floor(Math.random() * 500);

describe("bench-api", () => {
  it("corps JSON invalide : 400 (pas d'exception) ; accord auto seulement pour l'origine du banc", async () => {
    let foreign: Promise<{ ok: boolean }> | undefined;
    const brain = definePlugin({
      manifest: { id: "fake-brain", version: "0", licence: "MIT", provides: ["brain"] },
      apply(ctx) {
        const b: BrainService = {
          name: "faux", reset: () => {},
          async *run(input) {
            // Une demande d'un autre corps arrive pendant le tour du banc : elle ne doit pas être auto-répondue.
            foreign = k!.approvals.check({ tool: "x", args: {}, level: "write", summary: "autre", origin: "avatar" });
            const r = await k!.approvals.check({ tool: "y", args: {}, level: "write", summary: "banc", origin: input.origin });
            yield { type: "text", delta: r.ok ? "auto" : "non" };
            yield { type: "done", text: "" };
          },
        };
        ctx.provide("brain", b);
      },
    });
    k = new Kernel({ home: mkdtempSync(join(tmpdir(), "bench-")), logger: () => {}, plugins: [brain, bench] });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      plugins: [{ id: "brain", plugin: "fake-brain" }, { id: "bench", plugin: "bench-api", config: { port: PORT } }] });
    const url = `http://127.0.0.1:${PORT}/v1/chat/completions`;
    const bad = await fetch(url, { method: "POST", body: "{pas json" });
    expect(bad.status).toBe(400);
    expect((await fetch(url, { method: "POST", body: "null" })).status).toBe(200);
    const ok = await fetch(url, { method: "POST", headers: { "X-Approval": "auto" }, body: JSON.stringify({ messages: [{ role: "user", content: "salut" }] }) });
    expect(await ok.text()).toContain("auto");
    expect(new Set(k.approvals.pending().map((p) => p.origin))).toEqual(new Set(["avatar"])); // jamais auto-répondues
    void foreign;
  });
});
