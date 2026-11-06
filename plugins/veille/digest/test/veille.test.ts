import { describe, it, expect, afterEach } from "vitest";
import { Kernel, definePlugin, tr, type PluginDef, type CompletionRequest, type DocRef } from "@floppy/core";
import { parseFeed } from "../src/feeds.ts";
import { pretri, normUrl, sameStory, mentions, type Article } from "../src/pretri.ts";
import { digestMarkdown, triSystem, type PipelineResult } from "../src/pipeline.ts";
import { emptyPrefs } from "../src/prefs.ts";
import { createVeillePlugin } from "../src/index.ts";

const RSS = (items: { t: string; l: string; d?: string; desc?: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog IA</title>
${items.map((i) => `<item><title>${i.t}</title><link>${i.l}</link>${i.d ? `<pubDate>${i.d}</pubDate>` : ""}<description><![CDATA[${i.desc ?? "<p>Un extrait</p>"}]]></description></item>`).join("\n")}
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Simon</title>
<entry><title type="html">llama.cpp &amp; MTP</title><link rel="alternate" href="https://x.net/a"/><link rel="self" href="https://x.net/a.atom"/><updated>2026-11-05T10:00:00Z</updated><summary>Résumé &lt;b&gt;gras&lt;/b&gt;</summary></entry>
</feed>`;

describe("flux", () => {
  it("lit RSS 2.0 (HTML retiré, date ISO) et Atom (lien alternate)", () => {
    const r = parseFeed(RSS([{ t: "Gemma 5 sort", l: "https://blog.ai/gemma5", d: "Thu, 05 Nov 2026 08:00:00 GMT", desc: "<p>Le <b>nouveau</b> modèle&nbsp;arrive</p>" }]), "https://blog.ai/rss");
    expect(r).toEqual([{ titre: "Gemma 5 sort", url: "https://blog.ai/gemma5", date: "2026-11-05T08:00:00.000Z", extrait: "Le nouveau modèle arrive", source: "Blog IA" }]);
    const a = parseFeed(ATOM, "https://x.net/feed");
    expect(a[0]).toMatchObject({ titre: "llama.cpp & MTP", url: "https://x.net/a", source: "Simon", extrait: "Résumé gras" });
  });

  it("refuse ce qui n'est pas un flux", () => {
    expect(() => parseFeed("<html><body>hello</body></html>", "https://a.b")).toThrow(/pas un flux/);
  });
});

describe("pré-tri", () => {
  const art = (t: string, url: string, extra: Partial<Article> = {}): Article => ({ titre: t, url, source: "s", extrait: "", interet: "ia", ...extra });

  it("normalise les adresses (traqueurs, ancre, www, http)", () => {
    expect(normUrl("http://www.a.com/x/?utm_source=rss&id=3#top")).toBe("https://a.com/x?id=3");
  });

  it("retire déjà vus, vieux, bannis, doublons ; plafonne par intérêt", () => {
    const depuis = new Date("2026-11-04T00:00:00Z");
    const items = [
      art("Déjà lu hier", "https://a.com/1"),
      art("Vieille nouvelle", "https://a.com/2", { date: "2026-10-01T00:00:00Z" }),
      art("Le bitcoin s'envole encore", "https://a.com/3", { extrait: "crypto" }),
      art("OpenAI publie un nouveau modèle open weights", "https://a.com/4", { date: "2026-11-05T00:00:00Z" }),
      art("OpenAI publie un nouveau modèle open weights !", "https://b.com/4", { date: "2026-11-05T01:00:00Z" }),
      art("Llama.cpp ajoute MTP", "https://a.com/5", { date: "2026-11-05T02:00:00Z" }),
      art("Sans lien", "pas-une-adresse"),
    ];
    const r = pretri(items, { dejaVu: (u) => u === "https://a.com/1", depuis, bannis: () => ["bitcoin"], max: 1 });
    expect(r.retires).toMatchObject({ vus: 1, vieux: 1, bannis: 1, doublons: 1, invalides: 1, plafond: 1 });
    expect(r.gardes.map((a) => a.url)).toEqual(["https://a.com/5"]); // le plus récent
  });

  it("mots entiers, sans accents", () => {
    expect(mentions("Les cryptos et la Crypto-monnaie", "crypto")).toBe(true);
    expect(mentions("cryptographie", "crypto")).toBe(false);
    expect(sameStory("Gemma 5 arrive chez Google", "Google : Gemma 5 arrive")).toBe(true);
    expect(sameStory("Gemma 5 arrive", "Qwen 4 arrive")).toBe(false);
  });
});

describe("digest Markdown", () => {
  it("numérote dans tout le document et échappe les titres", () => {
    const it1 = { id: "ia", nom: "IA locale", description: "", flux: [], requetes: [], max: 5 };
    const it2 = { id: "bzh", nom: "Bretagne", description: "", flux: [], requetes: [], max: 5 };
    const r: PipelineResult = {
      sections: [
        { interet: it1, synthese: "Ça bouge.", articles: [{ titre: "A *gras*", url: "https://a.com/x_(y)", source: "a.com", extrait: "", interet: "ia", score: 9, resume: "Résumé A." }] },
        { interet: it2, synthese: "", articles: [{ titre: "B", url: "https://b.com", source: "b.com", extrait: "", interet: "bzh", score: 7, resume: "Résumé B." }] },
      ],
      vus: [], stats: { collectes: 2, versModele: 2, gardes: 2, erreurs: [], retires: {} },
    };
    const d = digestMarkdown(r, new Date(2026, 10, 6));
    expect(d.titre).toBe("Veille du 6 novembre 2026");
    expect(d.markdown).toContain("**1. A \\*gras\\***");
    expect(d.markdown).toContain("[Lire l'article](https://a.com/x_%28y%29)");
    expect(d.markdown).toContain("**2. B**");
    expect(d.articles.map((a) => [a.numero, a.interet])).toEqual([[1, "ia"], [2, "bzh"]]);
  });

  it("en anglais : titre, liens et consignes dans la langue de l'assistant", () => {
    const it1 = { id: "ia", nom: "Local AI", description: "", flux: [], requetes: [], max: 5 };
    const r: PipelineResult = {
      sections: [{ interet: it1, synthese: "", articles: [{ titre: "A", url: "https://a.com", source: "a.com", extrait: "", interet: "ia", score: 8, resume: "Sum." }] }],
      vus: [], stats: { collectes: 1, versModele: 1, gardes: 1, erreurs: [], retires: {} },
    };
    const d = digestMarkdown(r, new Date(2026, 10, 6), "", "en");
    expect(d.titre).toBe("News watch, November 6, 2026");
    expect(d.markdown).toContain("1 article on 1 topic.");
    expect(d.markdown).toContain("[Read the article](https://a.com)");
    const p = { ...emptyPrefs(), exemples: [{ titre: "Bad one", avis: "-" as const, date: "" }] };
    const s = triSystem(it1, p, "en");
    expect(s).toContain("summary in English");
    expect(s).toContain("[disliked] Bad one");
  });

  it("met les préférences dans les consignes du tri", () => {
    const p = { ...emptyPrefs(), evite: ["levées de fonds"], exemples: [{ titre: "Un article nul", avis: "-" as const, date: "" }] };
    const s = triSystem({ id: "ia", nom: "IA", description: "modèles locaux", flux: [], requetes: [], max: 5 }, p);
    expect(s).toContain("levées de fonds");
    expect(s).toContain("[pas aimé] Un article nul");
  });
});

// ------------------------------------------------------------------ bout en bout avec le noyau
let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

/** Faux cerveau du tri : note 8 les titres qui contiennent « garder », 2 les autres ; garde les consignes reçues. */
function fakeCompletion(seen: CompletionRequest[]): PluginDef<any> {
  return definePlugin({
    manifest: { id: "fake-llm", version: "0", licence: "MIT", provides: ["completion"] },
    apply(ctx) {
      ctx.offer("completion", {
        items: () => [{ id: "sonnet", label: "Sonnet" }],
        start(f) {
          f.provide("completion", {
            async complete(req) {
              seen.push(req);
              if (!req.schema) return { text: "Synthèse du jour." };
              const ids = [...req.prompt.matchAll(/^\[(\d+)\] (.*?) —/gm)].map((m) => ({ id: Number(m[1]), titre: m[2]! }));
              return { text: "", json: { articles: ids.map((x) => ({ id: x.id, score: /garder/i.test(x.titre) ? 8 : 2, resume: `Résumé de ${x.titre}.` })) } };
            },
          });
        },
      });
    },
  });
}

function fakeDocs(saved: { titre: string; markdown: string }[]): PluginDef<any> {
  return definePlugin({
    manifest: { id: "fake-docs", version: "0", licence: "MIT", provides: ["documents"] },
    apply(ctx) {
      ctx.provide("documents", {
        save: async (d): Promise<DocRef> => { saved.push(d); return { id: `doc${saved.length}`, titre: d.titre, date: "", source: d.source, tags: d.tags ?? [] }; },
        show: async () => "avatar",
        list: async () => [],
        get: async () => undefined,
      });
    },
  });
}

describe("plugin veille (avec le noyau)", () => {
  it("passage complet : tri, digest, avis pris en compte au passage suivant", async () => {
    let feed = RSS([
      { t: "A garder : Gemma 5", l: "https://blog.ai/1", d: new Date().toUTCString() },
      { t: "Pub pour un clavier", l: "https://blog.ai/2", d: new Date().toUTCString() },
      { t: "A garder aussi : crypto et IA", l: "https://blog.ai/3", d: new Date().toUTCString() },
    ]);
    const fetchFake = (async () => new Response(feed, { status: 200 })) as unknown as typeof fetch;
    const reqs: CompletionRequest[] = [];
    const saved: { titre: string; markdown: string }[] = [];
    const initiatives: { text: string }[] = [];
    k = new Kernel({ logger: () => {}, plugins: [fakeCompletion(reqs), fakeDocs(saved), createVeillePlugin({ fetch: fetchFake })] });
    k.bus.on("initiative", (p) => { initiatives.push(p); });
    await k.applyConfig({
      plugins: [
        { id: "llm", plugin: "fake-llm" }, { id: "docs", plugin: "fake-docs" },
        { id: "veille", plugin: "veille", config: { interets: { ia: { nom: "IA locale", description: "les modèles locaux", flux: ["https://blog.ai/rss"] } } } },
      ],
      slots: { "veille.tri": "llm/sonnet" },
    });
    expect(k.tasks.list().map((t) => t.key)).toEqual(["veille/quotidienne"]);

    const r1 = await k.tasks.run("veille/quotidienne", "manuel");
    expect(r1.ok).toBe(true);
    expect(r1.text).toBe("Ta veille est prête : 2 articles sur 1 sujet.");
    expect(saved[0]!.markdown).toContain("**1. A garder : Gemma 5**");
    expect(saved[0]!.markdown).not.toContain("clavier");
    expect(saved[0]!.markdown).toContain("Synthèse du jour.");
    expect(initiatives.at(-1)?.text).toBe(r1.text);
    // Le cerveau du tri est rendu après le passage : il ne tourne plus.
    await k.idle(); await k.idle();
    expect(k.status().some((s) => s.fork && s.state === "active")).toBe(false);

    // Avis : « le 1 ne m'intéresse pas » et « plus jamais de crypto ».
    const a1 = await k.tools.call("veille_avis", { article: 1, avis: "moins" });
    expect(a1.text).toMatch(/pas aimé « A garder : Gemma 5 »/);
    const a2 = await k.tools.call("veille_avis", { sujet: "crypto", avis: "jamais" });
    expect(a2.text).toMatch(/plus jamais « crypto »/);
    const art = await k.tools.call("veille_article", { article: 2 });
    expect(art.text).toContain("https://blog.ai/3");

    // Passage suivant : les anciens sont déjà vus ; le nouvel article crypto est retiré avant le modèle.
    feed = RSS([
      { t: "A garder : Gemma 5", l: "https://blog.ai/1", d: new Date().toUTCString() },
      { t: "A garder : la crypto remonte", l: "https://blog.ai/4", d: new Date().toUTCString() },
      { t: "A garder : Qwen 4", l: "https://blog.ai/5", d: new Date().toUTCString() },
    ]);
    reqs.length = 0;
    const r2 = await k.tasks.run("veille/quotidienne", "manuel");
    expect(r2.text).toBe("Ta veille est prête : 1 article sur 1 sujet.");
    const tri = reqs.find((q) => q.schema)!;
    expect(tri.prompt).toContain("Qwen 4");
    expect(tri.prompt).not.toContain("crypto");
    expect(tri.prompt).not.toContain("Gemma 5");
    expect(tri.system).toContain("[pas aimé] A garder : Gemma 5");

    // Troisième passage sans rien de nouveau.
    const r3 = await k.tasks.run("veille/quotidienne", "manuel");
    expect(r3.text).toMatch(/Rien de nouveau/);

    // Assistant en anglais : annonce, avis et outils en anglais.
    await k.settings.change("langue_assistant", "en", "ui");
    await k.idle();
    expect((await k.tasks.run("veille/quotidienne", "manuel")).text).toMatch(/^Nothing new/);
    expect((await k.tools.call("veille_avis", { sujet: "bitcoin", avis: "jamais" })).text).toMatch(/^Got it: never again “bitcoin”/);
  });

  it("sans centre d'intérêt : le dit ; sans cerveau du tri : échec clair ; ajout à la voix", async () => {
    k = new Kernel({ logger: () => {}, plugins: [createVeillePlugin()] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "veille" }], approvals: { write: "always" } });
    expect((await k.tasks.run("veille/quotidienne", "manuel")).text).toMatch(/aucun centre d'intérêt/);
    const add = await k.tools.call("veille_modifier_interet", { action: "ajouter", nom: "Bretagne", requetes: ["festival Bretagne"] });
    expect(add.status).toBe("done");
    const r = await k.tasks.run("veille/quotidienne", "manuel");
    expect(r.ok).toBe(false);
    expect(tr(r.text, "fr")).toMatch(/aucun cerveau choisi pour le tri/);
    expect(tr(r.text, "en")).toMatch(/no brain chosen for sorting/);
  });
});

describe("réglages de la veille", () => {
  it("une source décochée n'est plus lue ; « Essayer » dit ce que donne chaque flux", async () => {
    const asked: string[] = [];
    const fetchFake = (async (url: string) => {
      asked.push(String(url));
      if (String(url).includes("casse")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      return new Response(RSS([{ t: "A garder : X", l: `${String(url)}/1`, d: new Date().toUTCString() }]), { status: 200 });
    }) as unknown as typeof fetch;
    k = new Kernel({ logger: () => {}, plugins: [fakeCompletion([]), createVeillePlugin({ fetch: fetchFake })] });
    await k.applyConfig({
      plugins: [{ id: "llm", plugin: "fake-llm" }, { id: "veille", plugin: "veille", config: { interets: { ia: { nom: "IA", flux: ["https://a.com/rss", "https://b.com/rss"] } } } }],
      slots: { "veille.tri": "llm/sonnet" },
    });
    const prov = (await k.items.snapshot()).find((p) => p.id === "veille-interets")!;
    const item = prov.items[0]!;
    expect(item.children?.map((c) => [c.label, c.enabled])).toEqual([["a.com/rss", true], ["b.com/rss", true]]);
    expect((await k.items.run({ op: "child", provider: "veille-interets", id: "ia", child: "f:https://b.com/rss", on: false }, "ui")).ok).toBe(true);
    await k.tasks.run("veille/quotidienne", "manuel");
    expect(asked).toEqual(["https://a.com/rss"]);

    const r = await k.items.run({ op: "test", provider: "veille-interets", kind: "interet", values: { nom: "T", flux: ["https://a.com/rss", "https://casse.invalid/rss"] } }, "ui");
    expect(r.ok).toBe(false);
    expect(r.text).toBe("1 flux ne répond pas sur 2.");
    expect(r.children?.map((c) => tr(c.detail, "fr"))).toEqual([expect.stringContaining("1 articles"), "site introuvable (adresse fausse ou pas d'internet)"]);
    expect(tr(r.children?.[1]?.detail, "en")).toBe("site not found (wrong address or no internet)");
  });
});
