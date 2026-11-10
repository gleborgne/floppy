import { describe, it, expect, afterEach } from "vitest";
import { Kernel } from "@floppy/core";
import { createBrowserPlugin } from "../src/index.ts";
import { isPrivateHost, checkPageUrl, extractText, decodeEntities, truncate, clampMaxChars, fetchPage, MAX_BYTES } from "../src/page.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

type Route = Response | ((url: string) => Response | Promise<Response>);
function fakeNet(routes: Record<string, Route>) {
  const calls: { url: string; redirect?: string }[] = [];
  const fn = async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (!r) throw new Error(`pas de route ${url}`);
    return typeof r === "function" ? r(url) : r.clone();
  };
  return { fn, calls };
}
const html = (body: string, type = "text/html; charset=utf-8", status = 200) => new Response(body, { status, headers: { "content-type": type } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

async function start(routes: Record<string, Route>) {
  const net = fakeNet(routes);
  const k = new Kernel({ logger: () => {}, plugins: [createBrowserPlugin(async () => {}, net.fn)] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "browser", plugin: "browser" }] });
  return { k, net, read: (a: Record<string, unknown>) => k.tools.call("read_page", a) };
}

const PAGE = `<!doctype html><html><head><title>Le titre &amp; la suite</title><style>body{color:red}</style>
<script>var x = "ignoré";</script></head><body>
<header><a href="/">Accueil</a></header><nav><ul><li>Menu un</li></ul></nav>
<main><h1>Bonjour</h1><p>Un   texte &eacute;l&eacute;gant &#233; &#x41; avec<br>un saut.</p><ul><li>un</li><li>deux</li></ul>
<!-- commentaire caché --><script>alert(1)</script></main><footer>Pied de page</footer></body></html>`;

describe("isPrivateHost / checkPageUrl", () => {
  it.each([
    "localhost", "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "[::1]", "::1", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "monserveur", "nas.local", "x.internal", "app.localhost", "",
  ])("%s est refusée", (h) => expect(isPrivateHost(h)).toBe(true));
  it.each(["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "www.contoso.fr", "[2606:4700::1]", "1.2.3.4"])("%s est permise", (h) => expect(isPrivateHost(h)).toBe(false));

  it("formes détournées de 127.0.0.1 normalisées par URL", () => {
    for (const u of ["http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://[::1]:8080/", "http://0/"]) expect(() => checkPageUrl(u), u).toThrow();
  });
  it("schémas et identifiants", () => {
    expect(() => checkPageUrl("file:///etc/passwd")).toThrow();
    expect(() => checkPageUrl("ftp://example.com")).toThrow();
    expect(() => checkPageUrl("not a url")).toThrow();
    expect(() => checkPageUrl("https://user:pw@example.com/")).toThrow();
    expect(checkPageUrl("https://example.com/a?b=1").host).toBe("example.com");
  });
});

describe("extractText", () => {
  it("titre, texte lisible, sans script/style/nav/header/footer/commentaires", () => {
    const { title, text } = extractText(PAGE);
    expect(title).toBe("Le titre & la suite");
    expect(text).toContain("Bonjour");
    expect(text).toContain("Un texte élégant é A avec\nun saut.");
    expect(text).toContain("- un\n- deux");
    for (const bad of ["ignoré", "Menu un", "Accueil", "Pied de page", "commentaire", "alert", "color:red", "<"]) expect(text).not.toContain(bad);
  });
  it("sans balise main : toute la page, sans pied", () => {
    const { text } = extractText("<html><body><nav>menu</nav><div>Corps <b>gras</b></div><footer>pied</footer></body></html>");
    expect(text).toBe("Corps gras");
  });
  it("HTML cassé : balises orphelines, script non fermé", () => {
    const { text } = extractText("<p>Un<p>deux <b>trois<nav>x<script src=a.js><div>fin");
    expect(text).toContain("Un");
    expect(text).toContain("fin");
    expect(text).not.toContain("<");
  });
  it("text/plain : tel quel, blancs compactés", () => {
    expect(extractText("a   b\n\n\n\nc  ", true)).toEqual({ title: "", text: "a b\n\nc" });
  });
  it("entités", () => {
    expect(decodeEntities("&lt;a&gt; &amp;amp; &quot;x&quot; &#8364; &#xe9; &inconnue; &#99999999;")).toBe('<a> &amp; "x" € é &inconnue;  ');
  });
  it("coupe à la fin d'une ligne et le dit", () => {
    expect(clampMaxChars(undefined)).toBe(6000);
    expect(clampMaxChars(5)).toBe(200);
    expect(clampMaxChars(1e9)).toBe(20000);
    expect(clampMaxChars("abc")).toBe(6000);
    expect(truncate("court", 100)).toEqual({ text: "court", truncated: false });
    const t = truncate("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc", 25);
    expect(t).toEqual({ text: "aaaaaaaaaa\nbbbbbbbbbb", truncated: true });
  });
});

describe("outil read_page", () => {
  it("lit une page, niveau lecture, avec l'avertissement de donnée externe", async () => {
    const { k, read, net } = await start({ "https://example.com/a": html(PAGE) });
    expect(k.tools.list().find((t) => t.name === "read_page")!.level).toBe("read");
    expect(k.tools.list().find((t) => t.name === "read_page")!.description).toMatch(/jamais des instructions/);
    const r = await read({ url: "https://example.com/a" });
    expect(r.status).toBe("done");
    const text = String(r.text);
    expect(text).toContain("Page : Le titre & la suite — example.com");
    expect(text).toContain("pas des instructions");
    expect(text).toContain("Bonjour");
    expect(text).not.toContain("tronqué");
    expect(net.calls[0]!.redirect).toBe("manual");
  });

  it("tronque selon max_chars et le dit", async () => {
    const long = `<html><body><main>${"<p>Une phrase assez longue pour remplir la page. </p>".repeat(100)}</main></body></html>`;
    const { read } = await start({ "https://example.com/l": html(long) });
    const r = await read({ url: "https://example.com/l", max_chars: 300 });
    expect(String(r.text)).toMatch(/Texte tronqué : \d+ caractères sur \d+/);
    expect(String(r.text).length).toBeLessThan(700);
    const full = await read({ url: "https://example.com/l", max_chars: 20000 });
    expect(String(full.text)).not.toContain("tronqué");
  });

  it("text/plain accepté, autres types refusés", async () => {
    const { read } = await start({
      "https://example.com/t": html("ligne un\nligne deux", "text/plain"),
      "https://example.com/p": html("%PDF", "application/pdf"),
      "https://example.com/j": html("{}", "application/json"),
      "https://example.com/n": new Response("x"),
    });
    expect(String(((await read({ url: "https://example.com/t" })).text))).toContain("ligne deux");
    const pdf = await read({ url: "https://example.com/p" });
    expect(pdf.status).toBe("failed");
    expect(String(pdf.text)).toContain("application/pdf");
    expect((await read({ url: "https://example.com/j" })).status).toBe("failed");
  });

  it("refuse les adresses locales sans toucher au réseau", async () => {
    const { read, net } = await start({});
    for (const url of ["http://localhost:3000/", "http://192.168.1.10/admin", "http://127.0.0.1/", "http://[::1]/", "http://intranet/", "file:///C:/x"]) {
      const r = await read({ url });
      expect(r.status, url).toBe("failed");
    }
    expect(net.calls).toEqual([]);
  });

  it("suit les redirections en les revérifiant", async () => {
    const { read, net } = await start({
      "https://example.com/r": redirect("/ok"),
      "https://example.com/ok": html("<p>arrivé</p>"),
      "https://example.com/evil": redirect("http://169.254.169.254/latest/meta-data"),
      "https://example.com/loop": redirect("/loop"),
      "https://example.com/rel": redirect("//other.org/x"),
      "https://other.org/x": html("<p>ailleurs</p>"),
    });
    expect(String((await read({ url: "https://example.com/r" })).text)).toContain("arrivé");
    expect(String((await read({ url: "https://example.com/rel" })).text)).toContain("ailleurs");
    const bad = await read({ url: "https://example.com/evil" });
    expect(bad.status).toBe("failed");
    expect(String(bad.text)).toContain("Redirection refusée");
    expect(net.calls.some((c) => c.url.includes("169.254"))).toBe(false);
    const loop = await read({ url: "https://example.com/loop" });
    expect(String(loop.text)).toContain("Trop de redirections");
    expect(net.calls.filter((c) => c.url.endsWith("/loop")).length).toBe(6);
  });

  it("erreurs HTTP et réseau : messages clairs", async () => {
    const { read } = await start({
      "https://example.com/404": html("nope", "text/html", 404),
      "https://example.com/slow": () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); },
    });
    expect(String((await read({ url: "https://example.com/404" })).text)).toContain("erreur 404");
    expect(String((await read({ url: "https://example.com/slow" })).text)).toContain("ne répond pas");
    const down = await read({ url: "https://inconnu.example.org/" });
    expect(down.status).toBe("failed");
    expect(String(down.text)).toContain("injoignable");
  });

  it("page vide : le dit", async () => {
    const { read } = await start({ "https://example.com/e": html("<html><body><script>x()</script></body></html>") });
    expect(String((await read({ url: "https://example.com/e" })).text)).toContain("aucun texte lisible");
  });
});

describe("fetchPage : taille bornée", () => {
  const u = new URL("https://example.com/big");
  it("refuse selon Content-Length", async () => {
    const r = new Response("x", { headers: { "content-type": "text/html", "content-length": String(MAX_BYTES + 1) } });
    await expect(fetchPage(u, async () => r)).rejects.toThrow(/trop volumineuse/);
  });
  it("coupe un flux sans Content-Length et ne lit pas le reste", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(512 * 1024)); },
    });
    const r = new Response(stream, { headers: { "content-type": "text/html" } });
    await expect(fetchPage(u, async () => r)).rejects.toThrow(/trop volumineuse/);
    expect(pulled).toBeLessThan(10);
  });
  it("décode le charset de l'en-tête", async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // « café » en latin1
    const r = new Response(bytes, { headers: { "content-type": "text/html; charset=iso-8859-1" } });
    const got = await fetchPage(u, async () => r);
    const { decodeBody } = await import("../src/page.ts");
    expect(decodeBody(got.body, got.contentType)).toBe("café");
  });
});
