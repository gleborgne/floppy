// Recherche web en service (websearch, searxng…), pour la Veille et les autres plugins.

/** Un résultat de recherche. */
export interface SearchHit {
  titre: string;
  url: string;
  resume?: string;
  /** Site ou flux d'origine (ex. « lemonde.fr »). */
  source?: string;
  /** Date de publication, si connue (ISO 8601). */
  date?: string;
}

/**
 * Recherche web en service, pour les autres plugins (la Veille). Le même plugin donne en général aussi un outil
 * au cerveau : un seul code, deux usages. Offert élément par élément (ctx.offer) pour être choisi dans un slot.
 */
export interface SearchService {
  label?: string;
  /** Les requêtes partent dans le cloud. */
  cloud?: boolean;
  search(q: string, opts?: { max?: number; /** Seulement après cette date (au mieux). */ depuis?: Date; signal?: AbortSignal }): Promise<SearchHit[]>;
}

declare module "@floppy/core" {
  interface Services {
    search: SearchService;
  }
}
