// Recherche dans les conversations des agents Orca (`orca search`) : « qu'est-ce que l'agent a dit sur les migrations ? ».
// Orca indexe ces conversations seulement si l'utilisateur l'a activé (Orca : Réglages → Agent Session History).
// Le texte cherché vient de l'utilisateur : il passe comme UN argument de `orca.exe`, jamais par un shell.

export interface SearchHit {
  agent?: string;
  title?: string;
  cwd?: string;
  branch?: string;
  updatedAt?: string;
  evidence?: { snippet?: string; role?: string };
}
export interface SearchResult { kind?: string; reason?: string; hits?: SearchHit[] }

export const SEARCH_LIMIT = 5;
const MAX_QUERY = 200;

/** Arguments de `orca search`. Texte nettoyé : une ligne, pas de tiret en tête (il serait lu comme une option). */
export function searchArgs(texte: string, recent: boolean): string[] | undefined {
  const q = texte.replace(/[\r\n\t]+/g, " ").replace(/^[\s-]+/, "").trim().slice(0, MAX_QUERY);
  if (!q) return undefined;
  return ["search", "--query", q, "--scope", "conversation", "--limit", String(SEARCH_LIMIT), ...(recent ? ["--sort", "newest"] : [])];
}

const base = (p: string | undefined): string => (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
/** Extrait : marques de correspondance d'Orca ([[…]]) retirées, une ligne, 300 caractères au plus. */
const snippet = (s: string | undefined): string => (s ?? "").replace(/\[\[|\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

/** « il y a 2 h » : date d'une conversation passée. */
export function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`;
}

/** Réponse lisible par le cerveau. */
export function formatSearch(r: SearchResult | undefined, texte: string, now: number, indexing: boolean): string {
  const hits = r?.hits ?? [];
  if (!hits.length) return `Aucune conversation d'agent ne parle de « ${texte} ».${indexing ? " Orca n'a pas fini d'indexer : réessaie plus tard." : ""}`;
  const lines = hits.map((h) => {
    const where = [base(h.cwd), h.branch && h.branch !== "HEAD" ? `branche ${h.branch}` : ""].filter(Boolean).join(", ");
    const ts = h.updatedAt ? Date.parse(h.updatedAt) : NaN;
    const who = h.evidence?.role === "user" ? "l'utilisateur" : h.evidence?.role === "assistant" ? "l'agent" : "";
    return `- ${h.title ?? "(sans titre)"} (${[h.agent, where, Number.isFinite(ts) ? ago(ts, now) : ""].filter(Boolean).join(", ")})`
      + (h.evidence?.snippet ? ` : ${who ? `${who} : ` : ""}« ${snippet(h.evidence.snippet)} »` : "");
  });
  return [`Conversations d'agents qui parlent de « ${texte} » :`, ...lines, ...(indexing ? ["(Orca n'a pas fini d'indexer : il peut en manquer.)"] : [])].join("\n");
}
