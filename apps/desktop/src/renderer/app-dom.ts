// Petits outils communs aux modules de la page de l'avatar (app*.ts).

/** Élément de la page par son id : ils existent dans index.html (les `?.` des appelants restent par prudence). */
export const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** Message d'une exception (Error ou autre valeur lancée). */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Carte affichée : son élément garde de quoi se retraduire quand la langue change. */
export type CardEl = HTMLDivElement & { _relabel?: () => void };
