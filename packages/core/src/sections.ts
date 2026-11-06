// Rubriques de la fenêtre des réglages : aucune liste en dur dans l'app, tout vient des déclarations.
//
// API choisie : `ctx.settings.section(def | def[])` (un plugin) ; le noyau déclare les siennes (general, plugins).
// - Une rubrique a un id stable (« cerveau », « voix »…), un libellé, un ordre, une icône, une description,
//   et peut avoir un parent (`parent` : elle s'affiche alors dans la page du parent, pas dans le menu).
// - Plusieurs plugins peuvent déclarer la même rubrique : les déclarations FUSIONNENT. Champ par champ, la première
//   valeur donnée gagne (« premier libellé gagne ») ; si ce plugin est retiré, la suivante prend le relais.
// - Réglages et fournisseurs pointent une rubrique par son id. Un id inconnu tombe dans « plugins » (côté fenêtre).
import type { Text } from "./i18n.ts";

export interface SectionDef {
  id: string;
  label: Text;
  description?: Text;
  /** Ordre dans le menu (petit = haut). Défaut 100. */
  order?: number;
  /** Nom d'icône libre, lu par la fenêtre (facultatif). */
  icon?: string;
  /** Id d'une autre rubrique : celle-ci s'affiche comme un bloc de la page du parent. */
  parent?: string;
  /** Une seule liste pour toute la rubrique, quel que soit le plugin qui fournit les éléments (corps, connecteurs). */
  merge?: boolean;
  /** Vue spéciale fournie par la fenêtre à la place de la page générée (ex. « plugins », « assistant »). */
  view?: string;
}

export interface SectionInfo extends SectionDef {
  order: number;
  /** Plugins qui ont déclaré cette rubrique (le premier a donné le libellé). */
  sources: string[];
}

export class SectionRegistry {
  private decls: { source: string; def: SectionDef }[] = [];
  private listeners = new Set<() => void>();

  declare(source: string, defs: SectionDef[]): () => void {
    const mine = defs.map((def) => ({ source, def }));
    this.decls.push(...mine);
    this.changed();
    return () => {
      this.decls = this.decls.filter((d) => !mine.includes(d));
      this.changed();
    };
  }

  list(): SectionInfo[] {
    const by = new Map<string, SectionInfo>();
    const ordered = new Set<string>();
    for (const { source, def } of this.decls) {
      const cur = by.get(def.id);
      if (!cur) { by.set(def.id, { ...def, order: def.order ?? 100, sources: [source] }); if (def.order !== undefined) ordered.add(def.id); continue; }
      if (!cur.sources.includes(source)) cur.sources.push(source);
      // Premier gagne, champ par champ.
      if (def.order !== undefined && !ordered.has(def.id)) { cur.order = def.order; ordered.add(def.id); }
      if (cur.description === undefined && def.description !== undefined) cur.description = def.description;
      if (cur.icon === undefined && def.icon !== undefined) cur.icon = def.icon;
      if (cur.parent === undefined && def.parent !== undefined) cur.parent = def.parent;
      if (cur.merge === undefined && def.merge !== undefined) cur.merge = def.merge;
      if (cur.view === undefined && def.view !== undefined) cur.view = def.view;
    }
    return [...by.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* rien */ } }
  }
}
