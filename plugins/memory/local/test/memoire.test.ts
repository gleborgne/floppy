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

  describe("search_history", () => {
    const D = (m: number, d: number, h: number, mi = 0) => new Date(2026, m - 1, d, h, mi).toISOString();
    /** Remplit l'historique avec des dates connues, par l'API du service (puis réécrit `t` dans la base). */
    async function seeded() {
      const s = await start();
      const m = s.k.service<MemoryService>("memory")!;
      const rows: [string, string, string, string][] = [
        ["user", "Quel temps fait-il à Lyon ?", "a", D(11, 4, 9)],
        ["assistant", "Il fait doux à Lyon, 14 degrés.", "a", D(11, 4, 9)],
        ["user", "Rappelle-moi la recette du gratin dauphinois", "b", D(11, 5, 19, 30)],
        ["assistant", "Pommes de terre, crème, ail, muscade. " + "x".repeat(900), "b", D(11, 5, 19, 31)],
        ["user", "Merci", "b", D(11, 5, 19, 32)],
        ["assistant", "Avec plaisir.", "b", D(11, 5, 19, 32)],
        ["user", "Et la recette du gâteau ?", "c", D(11, 6, 8)],
      ];
      for (const [role, text, session] of rows) await m.record({ role: role as "user" | "assistant", text, session });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(s.home, "history.db"));
      rows.forEach(([, , , t], i) => db.prepare("UPDATE history SET t = ? WHERE rowid = ?").run(t, i + 1));
      db.close();
      return s;
    }

    it("une demande de l'utilisateur rend la réponse qui la suit, avec la date locale", async () => {
      const { k } = await seeded();
      const text = tr((await k.tools.call("search_history", { query: "Lyon" })).text, "fr");
      expect(text).toContain("[2026-11-04 09:00]");
      expect(text).toContain("Utilisateur : Quel temps fait-il à Lyon ?");
      expect(text).toContain("Assistant : Il fait doux à Lyon, 14 degrés.");
      expect(text.match(/\[2026/g)).toHaveLength(1); // demande et réponse touchées : un seul échange
    });

    it("une réponse rend la demande qui la précède, tronquée", async () => {
      const { k } = await seeded();
      const text = tr((await k.tools.call("search_history", { query: "muscade", role: "assistant" })).text, "fr");
      expect(text).toContain("Utilisateur : Rappelle-moi la recette du gratin dauphinois");
      expect(text).toContain("Assistant : Pommes de terre");
      expect(text).toContain("…"); // la réponse longue est coupée
      expect(text.length).toBeLessThan(900);
    });

    it("filtre par période (bornes incluses) et par rôle", async () => {
      const { k } = await seeded();
      const t = async (a: Record<string, unknown>) => tr((await k.tools.call("search_history", a)).text, "fr");
      const recette = await t({ query: "recette", since: "2026-11-05", until: "2026-11-05" });
      expect(recette).toContain("gratin");
      expect(recette).not.toContain("gâteau");
      expect(await t({ query: "recette", until: "2026-11-04" })).toBe("Rien trouvé dans l'historique.");
      expect(await t({ query: "recette", since: "2026-11-06" })).toContain("gâteau");
      expect(await t({ query: "plaisir", role: "user" })).toBe("Rien trouvé dans l'historique.");
    });

    it("sans mots mais avec une période : les derniers échanges, du plus ancien au plus récent", async () => {
      const { k } = await seeded();
      const text = tr((await k.tools.call("search_history", { since: "2026-11-05", until: "2026-11-05", limit: 2 })).text, "fr");
      expect(text).toContain("Merci");
      expect(text).toContain("Avec plaisir.");
      expect(text).not.toContain("gratin");
    });

    it("refuse sans mots ni période, une date illisible ou un rôle inconnu ; la requête reste sûre", async () => {
      const { k } = await seeded();
      expect((await k.tools.call("search_history", {})).status).toBe("failed");
      expect((await k.tools.call("search_history", { query: "x", since: "hier" })).status).toBe("failed");
      expect((await k.tools.call("search_history", { query: "x", since: "2026-02-31" })).status).toBe("failed");
      expect((await k.tools.call("search_history", { query: "Lyon", role: "robot" })).status).toBe("failed");
      expect((await k.tools.call("search_history", { query: 'Lyon" OR NEAR( * ) AND' })).status).toBe("done");
    });

    it("borne la longueur totale", async () => {
      const { k } = await start();
      const m = k.service<MemoryService>("memory")!;
      for (let i = 0; i < 20; i++) { await m.record({ role: "user", text: `chat ${"mot ".repeat(150)}`, session: `s${i}` }); }
      const text = tr((await k.tools.call("search_history", { query: "chat", limit: 20 })).text, "fr");
      expect(text.length).toBeLessThan(7000);
      expect(text).toContain("non montré");
    });

    it("le contrat MemoryService.search garde sa forme", async () => {
      const { k } = await seeded();
      const rows = await k.service<MemoryService>("memory")!.search("Lyon", 5);
      expect(rows.map((r) => r.role).sort()).toEqual(["assistant", "user"]);
      expect(Object.keys(rows[0]!).sort()).toEqual(["role", "session", "t", "text"]);
    });
  });
});
