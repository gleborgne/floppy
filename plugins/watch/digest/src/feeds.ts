// Lecture des flux RSS 2.0, Atom et RSS 1.0 (RDF). Rend des articles simples : titre, lien, date, extrait en texte.
import { XMLParser } from "fast-xml-parser";
import { T, TextError, type Text } from "@floppy/core";

export interface FeedItem {
  title: string;
  url: string;
  /** ISO 8601, si le flux la donne. */
  date?: string;
  /** Texte sans HTML, court. */
  excerpt: string;
  /** Nom du flux ou du site. */
  source: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Les flux mettent souvent du HTML échappé dans <description> : on le garde en texte et on le nettoie après.
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

/** Lit un flux. Lève une erreur claire si ce n'est pas un flux reconnu. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  let doc: Record<string, any>;
  try { doc = parser.parse(xml) as Record<string, any>; } catch (e) { const why = e instanceof Error ? e.message : String(e); throw new TextError(T(`flux illisible (${why})`, `unreadable feed (${why})`)); }
  const host = hostOf(feedUrl);
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    const source = text(ch.title) || host;
    return arr(ch.item).map((it) => item(text(it.title), text(it.link) || guidLink(it.guid), it.pubDate ?? it["dc:date"], it.description ?? it["content:encoded"], source));
  }
  if (doc.feed) {
    const source = text(doc.feed.title) || host;
    return arr(doc.feed.entry).map((e) => item(text(e.title), atomLink(e.link), e.published, e.summary ?? e.content, source));
  }
  const rdf = doc["rdf:RDF"];
  if (rdf) {
    const source = text(rdf.channel?.title) || host;
    return arr(rdf.item).map((it) => item(text(it.title), text(it.link), it["dc:date"], it.description, source));
  }
  throw new TextError(T("ce n'est pas un flux RSS ou Atom", "not an RSS or Atom feed"));
}

/** Le `fetch` des flux : `ctx.fetch` du plugin (ou un faux, dans les tests). */
export type FeedFetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

/** Télécharge et lit un flux, avec délai max (15 s par défaut, lecture du corps comprise : `timeoutMs` est donné à ctx.fetch). */
export async function fetchFeed(url: string, opts: { fetch: FeedFetch; timeoutMs?: number; signal?: AbortSignal }): Promise<FeedItem[]> {
  const f = opts.fetch;
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 15_000), ...(opts.signal ? [opts.signal] : [])];
  let r: Response;
  try {
    r = await f(url, { timeoutMs: opts.timeoutMs ?? 15_000, headers: { "user-agent": "Floppy-watch/0.1", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.any(signals) });
  } catch (e) {
    throw new TextError(netError(e, opts.timeoutMs ?? 15_000));
  }
  if (!r.ok) {
    throw new TextError(r.status === 404 ? T("adresse introuvable (404)", "address not found (404)")
      : r.status === 403 || r.status === 401 ? T(`accès refusé (${r.status})`, `access denied (${r.status})`)
      : T(`le site a répondu ${r.status}`, `the site answered ${r.status}`));
  }
  return parseFeed(await r.text(), url);
}

function item(title: string, url: string, date: unknown, body: unknown, source: string): FeedItem {
  const d = parseDate(text(date));
  return { title: clean(title), url: url.trim(), ...(d ? { date: d } : {}), excerpt: excerpt(text(body)), source };
}

function arr(x: unknown): any[] {
  return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}

/** Texte d'un nœud : chaîne, nombre, ou objet avec #text. */
function text(x: unknown): string {
  if (x === undefined || x === null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return text(x[0]);
  if (typeof x === "object" && "#text" in (x as object)) return text((x as Record<string, unknown>)["#text"]);
  return "";
}

function guidLink(g: unknown): string {
  const v = text(g);
  return /^https?:\/\//i.test(v) ? v : "";
}

/** Atom : le lien « alternate » (ou le premier sans rel). */
function atomLink(l: unknown): string {
  const links = arr(l).map((x) => (typeof x === "string" ? { href: x, rel: "alternate" } : { href: String(x?.["@_href"] ?? ""), rel: String(x?.["@_rel"] ?? "alternate") }));
  return (links.find((x) => x.rel === "alternate") ?? links[0])?.href ?? "";
}

function parseDate(s: string): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Retire le HTML et les blancs en trop. */
export function clean(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(html: string, max = 300): string {
  const t = clean(html);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Erreur réseau en mots simples. */
function netError(e: unknown, timeoutMs: number): Text {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  const s = Math.round(timeoutMs / 1000);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return T(`pas de réponse en ${s} s`, `no answer within ${s} s`);
  const code = err?.cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return T("site introuvable (adresse fausse ou pas d'internet)", "site not found (wrong address or no internet)");
  if (code === "ECONNREFUSED") return T("le site refuse la connexion", "the site refuses the connection");
  if (/CERT|SSL|TLS/i.test(code)) return T("certificat du site invalide", "invalid site certificate");
  const why = err?.message && err.message !== "fetch failed" ? ` (${err.message})` : "";
  return T(`site injoignable${why}`, `site unreachable${why}`);
}
