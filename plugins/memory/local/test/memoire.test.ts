import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import memory, { applyEdit } from "../src/index.ts";

describe("applyEdit : ligne exacte", () => {
  const cur = "- aime le café\n- aime le café noir sans sucre\n";
  it("remplace la ligne entière, pas la première qui contient", () => {
    expect(applyEdit(cur, "remplacer", "préfère le thé", "aime le café noir sans sucre")).toBe("- aime le café\n- préfère le thé\n");
    expect(applyEdit(cur, "supprimer", "x", "- AIME le café")).toBe("- aime le café noir sans sucre\n");
  });
  it("refuse un fragment", () => {
    expect(() => applyEdit(cur, "supprimer", "x", "café")).toThrow(/introuvable/);
    expect(() => applyEdit(cur, "remplacer", "y", "")).toThrow(/introuvable/);
  });
});

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

describe("memoriser : accord", () => {
  async function start() {
    const home = mkdtempSync(join(tmpdir(), "mem-"));
    const k = new Kernel({ logger: () => {}, plugins: [memory], home });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "memory", plugin: "memory", config: { dir: home } }] });
    const requests: { summary: string }[] = [];
    k.bus.on("approval.request", (r) => { requests.push(r); });
    return { k, home, requests };
  }

  it("l'accord montre la ligne et son remplacement", async () => {
    const { k, home, requests } = await start();
    writeFileSync(join(home, "USER.md"), "- aime le café\n");
    const p = k.tools.call("memoriser", { fichier: "utilisateur", action: "remplacer", texte: "aime le thé", ancien: "aime le café" });
    await new Promise((r) => setTimeout(r, 30));
    expect(requests[0]!.summary).toContain("« - aime le café »");
    expect(requests[0]!.summary).toContain("« aime le thé »");
    k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
    expect((await p).status).toBe("done");
    expect(readFileSync(join(home, "USER.md"), "utf8")).toBe("- aime le thé\n");
  });

  it("refuse l'écriture si le fichier a changé entre l'accord et l'écriture", async () => {
    const { k, home } = await start();
    writeFileSync(join(home, "USER.md"), "- aime le café\n");
    const p = k.tools.call("memoriser", { fichier: "utilisateur", action: "supprimer", texte: "aime le café" });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(home, "USER.md"), "- aime le café\n- autre\n");
    k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
    const r = await p;
    expect(r.status).toBe("failed");
    expect(readFileSync(join(home, "USER.md"), "utf8")).toBe("- aime le café\n- autre\n");
  });
});
