// Bibliothèque de modèles à télécharger (« modèles connus », résultats d'une recherche) : une aide pour les plugins.
// Elle déclare un fournisseur `layout: "library"` (montré par la fenêtre dans la bibliothèque des rôles de `offers`),
// lance les téléchargements (ctx.downloads), montre leur avancement et prévient le plugin quand un modèle est prêt.
// Voir docs/spec/telechargements.md.
import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "./plugin/context.ts";
import type { ItemInfo, ModelNeeds, OpResult } from "./catalog.ts";
import type { DownloadFile, DownloadState } from "./downloads.ts";
import { safeJoin } from "./downloads.ts";
import { T, tr, type Text } from "./i18n.ts";

export interface LibraryEntry {
  /** Unique dans la bibliothèque (lettres, chiffres, « - _ . / »). Sert aussi de clé de téléchargement. */
  id: string;
  label: Text;
  description?: Text;
  /** Fichiers, chemins relatifs au dossier du plugin. Deux entrées peuvent partager un fichier (ex. une voix et son modèle). */
  files: DownloadFile[];
  licence?: { name: string; url?: string };
  /** Étiquettes courtes : langues, « processeur », « tient dans la carte graphique »… */
  tags?: Text[];
  /** Court extrait sonore (http(s)) à écouter avant de télécharger : bouton « Écouter », ouvert dans le navigateur. */
  sample?: string;
  /** Service que rendra son élément, quand la bibliothèque en offre plusieurs (ex. « vad » ou « stt »). */
  service?: string;
  /** Ce qu'il demande pour tourner (mémoire, processeur ou puce graphique). Lu par le premier lancement. */
  needs?: ModelNeeds;
}

export interface LibraryOptions {
  /** Id du fournisseur (ex. "sherpa-library"). */
  id: string;
  section: string;
  /** Services que ces modèles rendront (la fenêtre montre la bibliothèque sous les rôles de ces services). */
  offers: string | string[];
  label: Text;
  description?: Text;
  order?: number;
  /** Modèles connus (lu à chaque fois). */
  entries(): LibraryEntry[];
  /** Le modèle est sur le disque : le plugin ajoute (ou met à jour) l'élément utilisable. `paths` : chemins complets des fichiers. */
  installed(entry: LibraryEntry, paths: string[]): void | Promise<void>;
  /** Le plugin a-t-il déjà l'élément de ce modèle ? Absent ou faux pour un modèle sur le disque : bouton « Ajouter à la liste ». */
  has?(entry: LibraryEntry): boolean;
  /** Le modèle va être supprimé du disque : le plugin retire l'élément. Lever une erreur (TextError) annule la suppression (ex. modèle en service). */
  removed?(entry: LibraryEntry): void | Promise<void>;
  /** Recherche en ligne : rend des entrées (gardées en mémoire pour leurs boutons). */
  search?(query: string): Promise<LibraryEntry[]>;
  searchHint?: Text;
  /** Modèle installé : id de l'élément offert qu'il donne (le premier, s'il en donne plusieurs). */
  itemOf?(entry: LibraryEntry): string | undefined;
  /** Ce qui manque pour faire tourner ces modèles (ex. le programme). Absent ou undefined : rien. */
  missing?(): Text | undefined;
}

/** « 1,2 Go » / « 1.2 GB ». */
export function formatBytes(n: number): Text {
  const units: [string, string][] = [["o", "B"], ["Ko", "KB"], ["Mo", "MB"], ["Go", "GB"], ["To", "TB"]];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const num = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0).replace(/\.0$/, "");
  return T(`${num.replace(".", ",")} ${units[i]![0]}`, `${num} ${units[i]![1]}`);
}

const join2 = (a: Text, sep: string, b: Text): Text => T(`${tr(a, "fr")}${sep}${tr(b, "fr")}`, `${tr(a, "en")}${sep}${tr(b, "en")}`);

/** Taille connue de toutes les entrées : la somme ; sinon undefined. */
export function entrySize(e: LibraryEntry): number | undefined {
  return e.files.every((f) => f.size !== undefined) ? e.files.reduce((n, f) => n + f.size!, 0) : undefined;
}

/** Déclare la bibliothèque. `refresh()` : à appeler quand la liste des modèles connus change. */
export function modelLibrary(ctx: Context, opts: LibraryOptions): { refresh(): void } {
  const found = new Map<string, LibraryEntry>(); // résultats de recherche (gardés pour leurs boutons)
  const fileOf = (f: DownloadFile) => safeJoin(ctx.downloads.dir, f.path);
  const onDisk = (e: LibraryEntry) => e.files.every((f) => {
    try { const s = statSync(fileOf(f)); return f.size === undefined || s.size === f.size; } catch { return false; }
  });
  const all = () => {
    const known = opts.entries();
    const ids = new Set(known.map((e) => e.id));
    return [...known, ...[...found.values()].filter((e) => !ids.has(e.id))];
  };
  const entry = (id: string) => all().find((e) => e.id === id);

  function item(e: LibraryEntry): ItemInfo {
    const d = ctx.downloads.get(e.id);
    const size = entrySize(e);
    const tags: Text[] = [...(size !== undefined ? [formatBytes(size)] : []), ...(e.licence ? [e.licence.name] : []), ...(e.tags ?? [])];
    // Boutons secondaires : écouter un extrait, lire la licence (ouverts dans le navigateur).
    const licence = [
      ...(e.sample ? [{ id: "listen", label: T("Écouter", "Listen") }] : []),
      ...(e.licence?.url ? [{ id: "licence", label: T("Licence", "Licence") }] : []),
    ];
    const one = typeof opts.offers === "string" ? opts.offers : opts.offers.length === 1 ? opts.offers[0] : undefined;
    const service = e.service ?? one;
    const base: ItemInfo = {
      id: e.id, label: e.label, enabled: true, tags,
      ...(e.description ? { detail: e.description } : {}),
      ...(e.needs ? { needs: e.needs } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(service ? { service } : {}),
    };
    if (d && (d.state === "queued" || d.state === "running")) {
      const total = d.total ?? size;
      const progress = total ? Math.min(1, d.received / total) : undefined;
      const text: Text = d.state === "queued" ? T("En attente…", "Waiting…")
        : total ? join2(T(`${Math.floor((progress ?? 0) * 100)} %`, `${Math.floor((progress ?? 0) * 100)}%`), " · ", join2(formatBytes(d.received), " / ", formatBytes(total)))
        : formatBytes(d.received);
      // Coupure : le téléchargement réessaie tout seul (en reprenant où il en était).
      const shown = d.retry ? join2(text, " · ", T(`nouvel essai ${d.retry}`, `retry ${d.retry}`)) : text;
      return { ...base, status: "loading", statusText: shown, progress: progress ?? 0, actions: [{ id: "cancel", label: T("Annuler", "Cancel") }] };
    }
    if (onDisk(e)) {
      const missing = opts.has && !opts.has(e);
      const uses = missing ? undefined : opts.itemOf?.(e);
      return {
        ...base, status: "ok", statusText: T("Installé", "Installed"), ...(uses ? { uses } : {}),
        actions: [...(missing ? [{ id: "use", label: T("Ajouter à la liste", "Add to the list") }] : []), { id: "remove", label: T("Supprimer", "Delete") }, ...licence],
      };
    }
    if (d?.state === "error") {
      return { ...base, status: "error", statusText: d.error ?? T("Échec", "Failed"), actions: [{ id: "download", label: T("Réessayer", "Retry") }, ...licence] };
    }
    return { ...base, actions: [{ id: "download", label: T("Télécharger", "Download") }, ...licence] };
  }

  /** Efface les fichiers d'une entrée, sauf ceux qu'une autre entrée installée utilise encore. */
  function erase(e: LibraryEntry): void {
    const kept = new Set(all().filter((x) => x.id !== e.id && onDisk(x)).flatMap((x) => x.files.map(fileOf)));
    for (const f of e.files) {
      const p = fileOf(f);
      if (kept.has(p)) continue;
      rmSync(p, { force: true });
      rmSync(p + ".part", { force: true });
      // Dossiers vidés : retirés jusqu'au dossier du plugin.
      for (let d = dirname(p); d.startsWith(ctx.downloads.dir) && d !== ctx.downloads.dir; d = dirname(d)) {
        try { if (readdirSync(d).length) break; rmdirSync(d); } catch { break; }
      }
    }
  }

  ctx.downloads.onChange((s: DownloadState) => {
    const e = entry(s.key);
    if (e && s.state === "done") {
      void Promise.resolve(opts.installed(e, e.files.map(fileOf)))
        .catch((err) => ctx.log("error", `bibliothèque : ajout de ${e.id} impossible`, { err: String(err) }))
        .finally(() => ctx.items.changed());
      return;
    }
    ctx.items.changed();
  });

  ctx.items.declare({
    id: opts.id, section: opts.section, layout: "library", offers: opts.offers, label: opts.label,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.order !== undefined ? { order: opts.order } : {}),
    ...(opts.searchHint ? { searchHint: opts.searchHint } : {}),
    ...(opts.missing ? { missing: opts.missing } : {}),
    list: () => {
      // Les résultats de recherche restent visibles tant qu'ils se téléchargent, ont échoué ou sont installés.
      const known = new Set(opts.entries().map((e) => e.id));
      return all().filter((e) => known.has(e.id) || ctx.downloads.get(e.id) || onDisk(e)).map(item);
    },
    async action(id, action): Promise<OpResult> {
      const e = entry(id);
      if (!e) return { ok: false, text: T("Modèle inconnu. Relance la recherche.", "Unknown model. Search again.") };
      switch (action) {
        case "download": {
          ctx.downloads.start({ key: e.id, label: e.label, files: e.files });
          return { ok: true, text: join2(T("Téléchargement lancé : ", "Download started: "), "", e.label) };
        }
        case "cancel":
          ctx.downloads.cancel(e.id);
          return { ok: true, text: T("Téléchargement annulé.", "Download cancelled.") };
        case "use":
          await opts.installed(e, e.files.map(fileOf));
          return { ok: true, text: join2(e.label, "", T(" est dans la liste.", " is in the list.")) };
        case "remove":
          await opts.removed?.(e);
          ctx.downloads.cancel(e.id);
          erase(e);
          return { ok: true, text: join2(e.label, "", T(" est supprimé.", " is deleted.")) };
        case "listen":
          return e.sample ? { ok: true, text: T("Extrait ouvert.", "Sample opened."), open: e.sample } : { ok: false, text: T("Pas d'extrait.", "No sample.") };
        case "licence":
          return e.licence?.url ? { ok: true, text: T("Licence ouverte.", "Licence opened."), open: e.licence.url } : { ok: false, text: T("Pas de lien de licence.", "No licence link.") };
        default:
          return { ok: false, text: T("Action inconnue.", "Unknown action.") };
      }
    },
    ...(opts.search ? {
      async search(query: string): Promise<OpResult> {
        const q = query.trim();
        if (q.length < 2) return { ok: true, text: "", items: [] };
        const list = await opts.search!(q);
        for (const e of list) found.set(e.id, e);
        return { ok: true, text: list.length ? "" : T("Rien trouvé.", "Nothing found."), items: list.map(item) };
      },
    } : {}),
  });

  return { refresh: () => ctx.items.changed() };
}

