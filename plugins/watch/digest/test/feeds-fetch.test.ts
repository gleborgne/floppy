// Les flux sont lus par le fetch donné (ctx.fetch du plugin), avec le délai demandé (réponse entière comprise).
import { describe, it, expect } from "vitest";
import { fetchFeed } from "../src/feeds.ts";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><item><title>Un</title><link>https://blog.contoso.com/1</link></item></channel></rss>`;

describe("fetchFeed", () => {
  it("passe par le fetch donné avec timeoutMs (15 s par défaut)", async () => {
    const seen: { url: string; timeoutMs?: number }[] = [];
    const http = async (url: string, init?: RequestInit & { timeoutMs?: number }) => {
      seen.push({ url, ...(init?.timeoutMs ? { timeoutMs: init.timeoutMs } : {}) });
      return new Response(RSS);
    };
    const items = await fetchFeed("https://blog.contoso.com/feed", { fetch: http });
    expect(items.map((i) => i.title)).toEqual(["Un"]);
    await fetchFeed("https://blog.contoso.com/feed", { fetch: http, timeoutMs: 10_000 });
    expect(seen).toEqual([{ url: "https://blog.contoso.com/feed", timeoutMs: 15_000 }, { url: "https://blog.contoso.com/feed", timeoutMs: 10_000 }]);
  });
});
