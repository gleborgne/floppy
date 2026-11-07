// Bibliothèques de modèles à télécharger (fournisseurs `layout: "library"`) : règles sans DOM, testées à part.
import { offersOf } from "./slot-sources.ts";

/** Sépare les bibliothèques des autres fournisseurs : elles ne sont pas montrées dans les pages, mais dans leur fenêtre. */
export function splitLibraries(providers: ItemProvider[] | undefined): { libraries: ItemProvider[]; others: ItemProvider[] } {
  const libraries: ItemProvider[] = [];
  const others: ItemProvider[] = [];
  for (const p of providers ?? []) (p.layout === "library" ? libraries : others).push(p);
  return { libraries, others };
}

/** Bibliothèques des modèles d'un service (ex. « stt »), d'un plugin précis si `source` est donné. */
export function librariesFor(libraries: ItemProvider[], service: string, source?: string): ItemProvider[] {
  return libraries.filter((p) => offersOf(p).includes(service) && (!source || p.source === source));
}

/** Téléchargements en cours dans des bibliothèques : nombre et avancement moyen (0 à 1, ou null si inconnu). */
export function downloadSummary(libs: ItemProvider[]): { count: number; progress: number | null } {
  const running = libs.flatMap((p) => p.items.filter((it) => it.status === "loading"));
  if (!running.length) return { count: 0, progress: null };
  const known = running.filter((it) => typeof it.progress === "number");
  const progress = known.length ? known.reduce((n, it) => n + (it.progress ?? 0), 0) / known.length : null;
  return { count: running.length, progress };
}

/**
 * Forme des bibliothèques sans ce qui bouge pendant un téléchargement (avancement, texte d'état). Même forme qu'avant :
 * la fenêtre met seulement à jour les barres, sans tout redessiner (pas de clignotement, la saisie et le focus restent).
 */
export function libraryShape(libraries: ItemProvider[]): string {
  return JSON.stringify(libraries.map((p) => [p.id, p.can, p.items.map((it) => [it.id, it.status === "loading" ? "loading" : it.status ?? "", (it.actions ?? []).map((a) => a.id)])]));
}

/** Pourcentage entier pour l'affichage (« 42 »). */
export const percent = (progress: number | null | undefined): number => Math.max(0, Math.min(100, Math.floor((progress ?? 0) * 100)));
