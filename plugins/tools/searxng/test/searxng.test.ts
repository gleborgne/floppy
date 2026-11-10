import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin, type Context } from "@floppy/core";
import type { SearchService } from "@floppy/contracts";
import { createSearxngPlugin, timeRange } from "../src/index.ts";

let kernels: Kernel[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const k of kernels) await k.stopAll();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  kernels = []; servers = [];
});

const FAKE = {
  results: [
    { title: "Floppy sort", url: "https://www.exemple.fr/floppy", content: "Une nouvelle version.", publishedDate: "2026-11-05T10:00:00", engine: "duckduckgo" },
    { title: "Mauvais lien", url: "javascript:alert(1)" },
    { title: "Autre", url: "https://blog.test/a", content: "", engine: "bing" },
  ],
};

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; urls: string[] }> {
  const urls: string[] = [];
  const s = createServer((req, res) => { urls.push(req.url ?? ""); handler!(req, res); });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, urls };
}
const json = (body: unknown) => (_: unknown, res: any) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

/** Consommateur : un slot « veille.recherche » (service search) emprunté le temps d'une recherche. */
async function boot(url: string, extra: Record<string, unknown> = {}) {
  let ctxRef: Context | undefined;
  const user = definePlugin({
    manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "veille.recherche", service: "search", section: "veille", label: "Recherche", none: "Aucune" }] },
    apply(ctx) { ctxRef = ctx; },
  });
  const k = new Kernel({ logger: () => {}, plugins: [createSearxngPlugin(), user] });
  kernels.push(k);
  await k.applyConfig({
    slots: { "veille.recherche": "sx/searxng" },
    plugins: [{ id: "sx", plugin: "searxng", config: { url, ...extra } }, { id: "u", plugin: "user" }],
  });
  return { k, ctx: ctxRef! };
}

describe("searxng", () => {
  it("service search emprunté par un slot : résultats convertis, requête JSON", async () => {
    const srv = await serve(json(FAKE));
    const { ctx } = await boot(srv.url);
    const b = await ctx.borrow<SearchService>("veille.recherche");
    expect(b).toBeDefined();
    expect(b!.service.cloud).toBe(false);
    const hits = await b!.service.search("floppy", { since: new Date(Date.now() - 3 * 86_400_000) });
    b!.release();
    expect(hits).toEqual([
      { title: "Floppy sort", url: "https://www.exemple.fr/floppy", summary: "Une nouvelle version.", source: "exemple.fr", date: new Date("2026-11-05T10:00:00").toISOString() },
      { title: "Autre", url: "https://blog.test/a", source: "blog.test" },
    ]);
    const u = new URL(srv.urls[0]!, "http://x");
    expect(u.pathname).toBe("/search");
    expect(u.searchParams.get("q")).toBe("floppy");
    expect(u.searchParams.get("format")).toBe("json");
    expect(u.searchParams.get("language")).toBe("fr");
    expect(u.searchParams.get("categories")).toBe("general");
    expect(u.searchParams.get("time_range")).toBe("week");
  });

  it("max limite le nombre de résultats", async () => {
    const srv = await serve(json(FAKE));
    const { ctx } = await boot(srv.url);
    const b = await ctx.borrow<SearchService>("veille.recherche");
    expect(await b!.service.search("x", { max: 1 })).toHaveLength(1);
    b!.release();
  });

  it("outil chercher_searxng : liste courte pour le cerveau", async () => {
    const srv = await serve(json(FAKE));
    const { k } = await boot(srv.url);
    const info = k.tools.list().find((x) => x.name === "chercher_searxng")!;
    expect(info.level).toBe("read");
    const r = await k.tools.call("chercher_searxng", { question: "floppy" });
    expect(r.status).toBe("done");
    expect(r.text).toContain("1. Floppy sort — exemple.fr — https://www.exemple.fr/floppy — Une nouvelle version.");
    expect((await k.tools.call("chercher_searxng", { question: " " })).status).toBe("failed");
  });

  it("application de la rubrique Connecteurs", async () => {
    const srv = await serve(json(FAKE));
    const { k } = await boot(srv.url);
    const kind = k.items.provider("apps-connecteurs")!.kinds!.find((x) => x.id === "searxng");
    expect(kind).toBeDefined();
    expect(kind?.cloud).toBeFalsy();
  });

  it("HTTP 403 (JSON désactivé) : message clair", async () => {
    const srv = await serve((_, res) => { res.statusCode = 403; res.end("Forbidden"); });
    const { k } = await boot(srv.url);
    const r = await k.tools.call("chercher_searxng", { question: "x" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/search\.formats/);
  });

  it("réponse qui n'est pas du JSON", async () => {
    const srv = await serve((_, res) => { res.setHeader("content-type", "text/html"); res.end("<html>salut</html>"); });
    const { k } = await boot(srv.url);
    const r = await k.tools.call("chercher_searxng", { question: "x" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/pas répondu en JSON/);
  });

  it("délai dépassé", async () => {
    const srv = await serve(() => { /* ne répond jamais */ });
    const { k } = await boot(srv.url, { timeoutMs: 500 });
    const r = await k.tools.call("chercher_searxng", { question: "x" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/ne répond pas/);
  });

  it("serveur absent", async () => {
    const { k } = await boot("http://127.0.0.1:1");
    const r = await k.tools.call("chercher_searxng", { question: "x" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/Impossible de joindre SearXNG/);
  });

  it("timeRange : la plus petite durée qui couvre", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const d = (j: number) => new Date(now.getTime() - j * 86_400_000);
    expect([timeRange(d(0.5), now), timeRange(d(3), now), timeRange(d(20), now), timeRange(d(200), now), timeRange(d(900), now)])
      .toEqual(["day", "week", "month", "year", undefined]);
  });

  it("logo : celui de SearXNG, livré avec le plugin", () => {
    expect(String(createSearxngPlugin().manifest.addable?.logo)).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
