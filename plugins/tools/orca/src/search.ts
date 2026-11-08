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
export interface SearchResult { kind?: string; reason?: string; hits?: SearchHit[]; nextCursor?: string; cursor?: string; truncated?: boolean; incomplete?: boolean; totalCount?: number; hostScope?: unknown }
export interface SearchFilters { path?: unknown; since?: unknown; agent?: unknown; cursor?: unknown }

export const SEARCH_LIMIT = 5;
const MAX_QUERY = 200;

/** Arguments de `orca search`. Texte nettoyé : une ligne, pas de tiret en tête (il serait lu comme une option). */
export function searchArgs(texte: string, recent: boolean, filters: SearchFilters = {}): string[] | undefined {
  const q = texte.replace(/[\r\n\t]+/g, " ").replace(/^[\s-]+/, "").trim().slice(0, MAX_QUERY);
  if (!q) return undefined;
  const args = ["search", "--query", q, "--scope", "conversation", "--limit", String(SEARCH_LIMIT), ...(recent ? ["--sort", "newest"] : [])];
  for (const [key, flag] of [["path", "--path"], ["agent", "--agent"], ["since", "--since"], ["cursor", "--cursor"]] as const) {
    const value = filters[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /^[\s-]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return undefined;
    if (key === "since" && (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) return undefined;
    args.push(flag, value);
  }
  return args;
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
export function formatSearch(r: SearchResult | undefined, texte: string, now: number, indexing: boolean, en = false): string {
  const hits = r?.hits ?? [];
  const incomplete = indexing || r?.incomplete === true || r?.truncated === true;
  const warning = incomplete ? (en ? "The index or page is incomplete; results may be missing." : "Orca n'a pas fini d'indexer ou la page est partielle : il peut en manquer ; réessaie plus tard.") : "";
  const scope = en ? "Search covers only the selected Orca host; no result is not proof of no work." : "La recherche couvre seulement l'hôte Orca sélectionné ; aucun résultat ne prouve pas une absence de travail.";
  if (!hits.length) return [en ? `No matching agent conversation found for “${texte}”.` : `Aucune conversation d'agent trouvée pour « ${texte} ».`, warning, scope].filter(Boolean).join("\n");
  const lines = hits.slice(0, SEARCH_LIMIT).map((h) => {
    const where = [base(h.cwd), h.branch && h.branch !== "HEAD" ? `${en ? "branch" : "branche"} ${h.branch}` : ""].filter(Boolean).join(", ");
    const ts = h.updatedAt ? Date.parse(h.updatedAt) : NaN;
    const who = h.evidence?.role === "user" ? (en ? "user" : "l'utilisateur") : h.evidence?.role === "assistant" ? (en ? "agent" : "l'agent") : "";
    const date = Number.isFinite(ts) ? en ? `${Math.max(0, Math.round((now - ts) / 60000))} min ago` : ago(ts, now) : "";
    return `- ${snippet(h.title) || (en ? "(untitled)" : "(sans titre)")} (${[h.agent, where, date].filter(Boolean).join(", ")})`
      + (h.evidence?.snippet ? ` : ${who ? `${who} : ` : ""}« ${snippet(h.evidence.snippet)} »` : "");
  });
  return [en ? `Agent conversations matching “${texte}”:` : `Conversations d'agents qui parlent de « ${texte} » :`, ...lines, warning, r?.nextCursor || r?.cursor ? (en ? "More results: use the raw cursor to continue." : "Suite : utilise le curseur brut pour continuer.") : "", scope].filter(Boolean).join("\n");
}
