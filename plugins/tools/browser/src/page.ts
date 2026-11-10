// Lecture d'une page web : adresses autorisées, téléchargement borné, extraction du texte lisible.
// Sans dépendance : l'analyse est faite par expressions régulières, assez robuste pour du texte à lire à voix haute.
import { T, TextError, tr } from "@floppy/core";

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_CHARS = 6000;
export const MIN_MAX_CHARS = 200;
export const MAX_MAX_CHARS = 20_000;

export type FetchLike = (url: string | URL, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : undefined;
}

function privateIpv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}

/** Vrai si l'hôte (sans crochets) désigne une machine locale ou un réseau privé. Le navigateur de l'URL a déjà normalisé 2130706433, 0x7f.1… en 127.0.0.1. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      if (mapped[1]) { const v = ipv4(mapped[1]); return !v || privateIpv4(v); }
      const hi = parseInt(mapped[2]!, 16), lo = parseInt(mapped[3]!, 16);
      return privateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    const first = parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 et fe80::/10
  }
  if (!host.includes(".")) return true; // localhost, noms de machines du réseau local
  return /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host);
}

/** Valide l'adresse demandée : http(s) seulement, jamais une machine locale ou privée. */
export function checkPageUrl(raw: unknown): URL {
  const s = String(raw ?? "").trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new TextError(T("Adresse invalide.", "Invalid address.")); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new TextError(T("Seules les adresses http et https se lisent.", "Only http and https addresses can be read."));
  if (u.username || u.password) throw new TextError(T("Une adresse avec identifiant ou mot de passe n'est pas lue.", "An address with a user name or password is not read."));
  if (isPrivateHost(u.hostname)) throw new TextError(T("Cette adresse est une machine locale ou un réseau privé : je ne la lis pas.", "This address is a local machine or a private network: I do not read it."));
  return u;
}

export interface Fetched { url: URL; contentType: string; body: Uint8Array }

/** Télécharge en suivant au plus MAX_REDIRECTS redirections, chacune revérifiée ; corps limité à MAX_BYTES. */
export async function fetchPage(start: URL, http: FetchLike, signal?: AbortSignal, timeoutMs = 15_000): Promise<Fetched> {
  let url = start;
  for (let hop = 0; ; hop++) {
    let r: Response;
    try {
      r = await http(url, {
        redirect: "manual", timeoutMs, signal,
        headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": "Mozilla/5.0 (compatible; Floppy)" },
      });
    } catch (e) {
      if (signal?.aborted) throw new TextError(T("annulé", "cancelled"));
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new TextError(T(`La page ne répond pas (délai de ${Math.round(timeoutMs / 1000)} s dépassé).`, `The page is not answering (${Math.round(timeoutMs / 1000)} s timeout).`));
      throw new TextError(T(`Page injoignable : ${e instanceof Error ? e.message : String(e)}`, `Page unreachable: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      void r.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new TextError(T("Trop de redirections.", "Too many redirects."));
      try { url = checkPageUrl(new URL(r.headers.get("location")!, url).href); }
      catch (e) {
        if (e instanceof TextError) throw new TextError(T(`Redirection refusée : ${tr(e.text, "fr")}`, `Redirect refused: ${tr(e.text, "en")}`));
        throw e;
      }
      continue;
    }
    if (!r.ok) {
      void r.body?.cancel().catch(() => {});
      throw new TextError(T(`La page répond avec une erreur ${r.status}.`, `The page answers with error ${r.status}.`));
    }
    const contentType = (r.headers.get("content-type") ?? "").toLowerCase();
    if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/.test(contentType.trim())) {
      void r.body?.cancel().catch(() => {});
      throw new TextError(T(`Ce n'est pas une page de texte (${contentType.split(";")[0] || "type inconnu"}) : je ne lis que le HTML et le texte.`, `This is not a text page (${contentType.split(";")[0] || "unknown type"}): I only read HTML and plain text.`));
    }
    const declared = Number(r.headers.get("content-length"));
    if (declared > MAX_BYTES) { void r.body?.cancel().catch(() => {}); throw tooBig(); }
    return { url, contentType, body: await readCapped(r) };
  }
}

const tooBig = () => new TextError(T("Page trop volumineuse (plus de 2 Mo).", "Page too large (over 2 MB)."));

async function readCapped(r: Response): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { void reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** Décode selon le charset de l'en-tête, sinon de la balise meta, sinon UTF-8. */
export function decodeBody(body: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(body.subarray(0, 2048)))?.[1];
  try { return new TextDecoder(charset ?? "utf-8").decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", euro: "€", eacute: "é", egrave: "è", ecirc: "ê",
  agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", ucirc: "û", ugrave: "ù", icirc: "î", iuml: "ï", euml: "ë", middot: "·",
  deg: "°", times: "×", bull: "•", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
      return String.fromCodePoint(n);
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

const DROP = "script|style|noscript|template|svg|iframe|object|embed|canvas|nav|header|footer|aside|head|select|button";
const BLOCK = "p|div|section|article|main|h[1-6]|ul|ol|li|tr|table|blockquote|pre|figure|figcaption|dl|dt|dd|details|summary|hr|br";

export interface Extracted { title: string; text: string }

/** Titre et texte lisible d'une page HTML. Texte brut (text/plain) : rendu tel quel, blancs compactés. */
export function extractText(html: string, plain = false): Extracted {
  if (plain) return { title: "", text: compact(html) };
  const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  // Le contenu principal s'il est balisé ; sinon la page entière.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(s);
  if (main) s = main[2]!;
  s = s.replace(new RegExp(`<(${DROP})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), " ");
  s = s.replace(new RegExp(`<(${DROP})\\b[^>]*\\/?>`, "gi"), " "); // balises orphelines (non fermées)
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(new RegExp(`<\\/?(${BLOCK})\\b[^>]*>`, "gi"), "\n");
  s = s.replace(/<[^>]*>/g, " ");
  return { title, text: compact(decodeEntities(s)) };
}

function compact(s: string): string {
  return s
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ​]+/g, " ").trim())
    .join("\n")
    .replace(/(\n- [^\n]*)\n+(?=- )/g, "$1\n") // éléments de liste serrés
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function clampMaxChars(v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(n)));
}

/** Coupe à `max` caractères, de préférence à une fin de ligne ou de phrase. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  if (at > max * 0.6) cut = cut.slice(0, at + 1);
  return { text: cut.trimEnd(), truncated: true };
}
