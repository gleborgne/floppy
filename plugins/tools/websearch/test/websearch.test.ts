import { describe, it, expect, afterEach } from "vitest";
import { Kernel, definePlugin, type Context, type SearchService } from "@floppy/core";
import { createWebsearchPlugin, parseResult, resultsA2ui, type SearchResult } from "../src/index.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

const RES: SearchResult = {
  reponse: "Demain à Paris : nuageux, 8 à 13 degrés.",
  resultats: [{ titre: "Météo Paris", resume: "Ciel couvert.", url: "https://meteo.example/paris", source: "Météo Exemple" }],
};

describe("recherche web", () => {
  it("outil lent avec phrase d'attente ; réponse + liens pour le cerveau", async () => {
    const asked: string[] = [];
    const k = new Kernel({ logger: () => {}, plugins: [createWebsearchPlugin(async (q) => { asked.push(q); return RES; })] });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "websearch", plugin: "websearch" }] });
    const info = k.tools.list().find((t) => t.name === "chercher_web")!;
    expect(info.level).toBe("read");
    expect(info.waitPhrase).toMatch(/cherche/);
    const r = await k.tools.call("chercher_web", { question: "météo Paris demain" });
    expect(r.status).toBe("done");
    expect(r.text).toContain("nuageux");
    expect(r.text).toContain("https://meteo.example/paris");
    expect(asked).toEqual(["météo Paris demain"]);
    // Application de la rubrique Connecteurs, cloud.
    expect(k.items.provider("apps-connecteurs")!.kinds!.find((x) => x.id === "websearch")?.cloud).toBe(true);
  });

  it("panne du CLI : échec propre", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [createWebsearchPlugin(async () => { throw new Error("Claude Code n'est pas installé"); })] });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "websearch", plugin: "websearch" }] });
    const r = await k.tools.call("chercher_web", { question: "x" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/pas installé/);
  });

  it("lit le JSON (avec ```json), garde seulement les liens http(s)", () => {
    const r = parseResult('Voici :\n```json\n{"reponse":"ok","resultats":[{"titre":"a","resume":"b","url":"https://x.y","source":"X"},{"titre":"bad","url":"javascript:alert(1)"}]}\n```');
    expect(r.reponse).toBe("ok");
    expect(r.resultats.map((x) => x.url)).toEqual(["https://x.y"]);
  });

  it("A2UI : surface avec la réponse et un bouton Ouvrir par résultat", () => {
    const msgs = resultsA2ui("météo", RES, "claude") as any[];
    const comps = msgs[0].surfaceUpdate.components as { id: string; component: any }[];
    expect(msgs[1].beginRendering.root).toBe("root");
    const btn = comps.find((c) => c.component.Button)!;
    expect(btn.component.Button.action).toEqual({ name: "ouvrir_url", context: [{ key: "url", value: { literalString: "https://meteo.example/paris" } }] });
  });
});

describe("service search (slot)", () => {
  it("le même moteur est offert au consommateur d'un slot : résultats convertis, max respecté", async () => {
    const asked: string[] = [];
    const many: SearchResult = { reponse: "ok", resultats: [
      { titre: "A", resume: "ra", url: "https://a.test/", source: "A.test" },
      { titre: "B", resume: "", url: "https://b.test/", source: "" },
    ] };
    let ctxRef: Context | undefined;
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "veille.recherche", service: "search", section: "veille", label: "Recherche", none: "Aucune" }] },
      apply(ctx) { ctxRef = ctx; },
    });
    const k = new Kernel({ logger: () => {}, plugins: [createWebsearchPlugin(async (q) => { asked.push(q); return many; }), user] });
    kernels.push(k);
    await k.applyConfig({ slots: { "veille.recherche": "websearch/claude" }, plugins: [{ id: "websearch", plugin: "websearch" }, { id: "u", plugin: "user" }] });
    // L'outil du cerveau est toujours là.
    expect(k.tools.list().some((t) => t.name === "chercher_web")).toBe(true);
    const b = await ctxRef!.borrow<SearchService>("veille.recherche");
    expect(b!.service.cloud).toBe(true);
    expect(await b!.service.search("ia")).toEqual([
      { titre: "A", url: "https://a.test/", resume: "ra", source: "A.test" },
      { titre: "B", url: "https://b.test/" },
    ]);
    expect(await b!.service.search("ia", { max: 1 })).toHaveLength(1);
    expect(asked).toEqual(["ia", "ia"]);
    b!.release();
  });
});

describe("recherche web en anglais", () => {
  it("consignes, fenêtre et phrase d'attente suivent la langue de l'assistant", async () => {
    const { systemFor } = await import("../src/index.ts");
    expect(systemFor(new Date(2026, 10, 6), "en")).toContain("English-speaking");
    expect(systemFor(new Date(2026, 10, 6), "en")).toContain("Today is Friday, November 6, 2026.");
    expect(JSON.stringify(resultsA2ui("q", { reponse: "", resultats: RES.resultats }, "claude", "en"))).toContain("\"Open\"");
    const langs: (string | undefined)[] = [];
    const k = new Kernel({ logger: () => {}, plugins: [createWebsearchPlugin(async (_q, _c, _w, _s, lang) => { langs.push(lang); return RES; })] });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "websearch", plugin: "websearch" }] });
    await k.settings.change("langue_assistant", "en", "ui");
    await k.idle();
    expect(k.tools.list().find((t) => t.name === "chercher_web")!.waitPhrase).toBe("Let me look that up online, one moment.");
    await k.tools.call("chercher_web", { question: "weather" });
    expect(langs).toEqual(["en"]);
  });

  it("logo : Claude par défaut, aucun avec Codex", async () => {
    const logo = async (engine: string) => {
      const k = new Kernel({ logger: () => {}, plugins: [createWebsearchPlugin(async () => RES)] });
      kernels.push(k);
      await k.applyConfig({ plugins: [{ id: "websearch", plugin: "websearch", config: { engine } }] });
      return (await k.items.provider("apps-connecteurs")!.list())[0]?.logo;
    };
    expect(String(await logo("claude"))).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await logo("codex")).toBeUndefined();
  });
});
