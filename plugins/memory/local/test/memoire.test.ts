import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, TextError, tr } from "@floppy/core";
import type { MemoryService } from "@floppy/contracts";
import memory, { applyEdit } from "../src/index.ts";

describe("applyEdit : ligne exacte", () => {
  const cur = "- aime le café\n- aime le café noir sans sucre\n";
  it("remplace la ligne entière, pas la première qui contient", () => {
    expect(applyEdit(cur, "replace", "préfère le thé", "aime le café noir sans sucre")).toBe("- aime le café\n- préfère le thé\n");
    expect(applyEdit(cur, "delete", "x", "- AIME le café")).toBe("- aime le café noir sans sucre\n");
  });
  it("refuse un fragment", () => {
    expect(() => applyEdit(cur, "delete", "x", "café")).toThrow(/introuvable/);
    expect(() => applyEdit(cur, "replace", "y", "")).toThrow(/introuvable/);
  });
  it("donne aussi l'erreur en anglais", () => {
    try { applyEdit(cur, "delete", "x", "café"); throw new Error("erreur attendue"); }
    catch (e) { expect(e).toBeInstanceOf(TextError); expect(tr((e as TextError).text, "en")).toContain("Line not found"); }
  });
});

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

describe("remember : accord", () => {
  async function start(language = "fr") {
    const home = mkdtempSync(join(tmpdir(), "mem-"));
    const k = new Kernel({ logger: () => {}, plugins: [memory], home });
    kernels.push(k);
    await k.applyConfig({ assistant: { language }, plugins: [{ id: "memory", plugin: "memory", config: { dir: home } }] });
    const requests: { summary: string }[] = [];
    k.bus.on("approval.request", (r) => { requests.push(r); });
    return { k, home, requests };
  }

  it("l'accord montre la ligne et son remplacement", async () => {
    const { k, home, requests } = await start();
    writeFileSync(join(home, "USER.md"), "- aime le café\n");
    const p = k.tools.call("remember", { file: "user", action: "replace", text: "aime le thé", old: "aime le café" });
    expect(k.tools.list().map((t) => t.name).filter((n) => ["memoriser", "chercher_historique"].includes(n))).toEqual([]); // les anciens noms français n'existent plus
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
    const p = k.tools.call("remember", { file: "user", action: "delete", text: "aime le café" });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(home, "USER.md"), "- aime le café\n- autre\n");
    k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
    const r = await p;
    expect(r.status).toBe("failed");
    expect(readFileSync(join(home, "USER.md"), "utf8")).toBe("- aime le café\n- autre\n");
  });

  it("traduit les résultats de mémorisation et de recherche en anglais", async () => {
    const { k } = await start("en");
    expect((await k.tools.call("search_history", { query: "coffee" })).text).toBe("Nothing found in history.");
    await k.service<MemoryService>("memory")!.record({ role: "user", text: "coffee", session: "avatar" });
    expect((await k.tools.call("search_history", { query: "coffee" })).text).toContain("User : coffee");
    const p = k.tools.call("remember", { file: "notes", action: "add", text: "Likes coffee" });
    await new Promise((r) => setTimeout(r, 30));
    k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
    expect((await p).text).toBe("Remembered.");
  });
});
