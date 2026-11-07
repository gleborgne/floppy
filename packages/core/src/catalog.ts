// Catalogue des éléments : ce que la fenêtre des réglages montre et que l'utilisateur peut ajouter, modifier,
// désactiver ou supprimer. Rien n'est en dur dans la fenêtre : chaque plugin déclare un ou plusieurs
// « fournisseurs » d'éléments, rangés par rubrique.
//
//   rubrique « cerveau »      : modèles locaux (llm-llamacpp), modèles distants (llm-openai), Claude (brain-claude-cli)…
//   rubrique « voix »         : voix de la cascade locale…
//   rubrique « connecteurs »  : serveurs MCP, commandes (tools), Orca (application)…
//   rubrique « corps »        : corps branchés (body-hub)
//   rubrique « avatars »      : avatars de l'app Electron (body-electron)
//
// Un fournisseur décrit ses types d'éléments (`kinds`) avec des champs (`FieldDef`). La fenêtre en tire les
// formulaires. Il garde ses éléments où il veut ; `ItemStore` aide à garder ceux ajoutés par l'utilisateur
// dans <home>/items/<fournisseur>.json (floppy.yml n'est jamais réécrit).
//
// Désactiver ≠ supprimer : un élément désactivé reste dans la liste, mais Floppy ne le voit plus.
//
// Sécurité :
// - Ajouter, modifier, supprimer : clic ou CLI seulement (jamais à la voix). Un MCP local lance une commande.
// - Activer / désactiver à la voix : désactiver = libre ; activer un élément « cloud » = accord.
// - Les secrets (clés d'API, jetons) ne passent jamais par les fichiers : voir secrets.ts.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApprovalManager } from "./approval.ts";
import type { Audit } from "./audit.ts";
import { allTexts, errorText, T, tr, type Text } from "./i18n.ts";
import type { Backend } from "./machine.ts";

/** Ce que demande un modèle pour tourner (bibliothèque de modèles ; lu par le premier lancement). */
export interface ModelNeeds {
  /** Mémoire en octets (fichiers + contexte et tampons). */
  memory: number;
  /** « cpu » : tourne sur le processeur (RAM). « gpu » : sur la puce graphique (mémoire des modèles). */
  device: "cpu" | "gpu";
  /** Moteurs acceptés sur la puce graphique (absent : tous). Ex. ["cuda"]. */
  backends?: Backend[];
}

/**
 * « audio » : un enregistrement de voix, fait au micro ou importé dans la fenêtre. La valeur est soit une adresse
 * data:audio/wav (nouvel enregistrement, à lire avec wavFromDataUrl), soit ce que le plugin a rendu (ex. le chemin du
 * fichier déjà gardé), inchangé.
 */
export type FieldType = "text" | "number" | "boolean" | "select" | "secret" | "path" | "list" | "textarea" | "keyvalue" | "audio";

export interface FieldDef {
  key: string;
  label: Text;
  type: FieldType;
  /** select : choix possibles. */
  options?: { value: string; label: Text }[];
  placeholder?: Text;
  hint?: Text;
  required?: boolean;
  default?: unknown;
  /** Rangé dans « Avancé ». */
  advanced?: boolean;
  /** Montré seulement si un autre champ a une de ces valeurs. */
  showIf?: { key: string; values: unknown[] };
  /** path : filtres du sélecteur de fichier ; dossier si directory. */
  filters?: { name: string; extensions: string[] }[];
  directory?: boolean;
  min?: number;
  max?: number;
  /** audio : phrases à lire au micro (une au hasard, « Autre phrase » en change). */
  prompts?: Text[];
  /** audio : champ qui reçoit la phrase lue (ex. le texte de l'enregistrement). */
  textKey?: string;
  /** audio : durée conseillée, en secondes. */
  seconds?: { min: number; max: number };
}

export interface ItemKind {
  id: string;
  label: Text;
  description?: Text;
  fields: FieldDef[];
  /** Les données partent dans le cloud. */
  cloud?: boolean;
  /** Services que le plugin ajouté fournit (ex. « wakeword ») : le catalogue ouvert depuis un rôle ne montre que ceux-là. */
  provides?: string[];
  /** Mots qui désignent ce type à l'oral (« ajoute Orca »). */
  aliases?: string[];
  /** Un seul élément de ce type à la fois. */
  single?: boolean;
}

/** Sous-élément activable (ex. un outil d'un connecteur, une voix d'un moteur). */
export interface ItemChild {
  id: string;
  label: Text;
  detail?: Text;
  enabled: boolean;
  /** Étiquette courte (« lecture · libre », « écriture · accord »). */
  tag?: Text;
  tone?: "ok" | "warn" | "danger";
}

export type ItemStatus = "ok" | "warn" | "error" | "off" | "loading";

export interface ItemInfo {
  id: string;
  label: Text;
  detail?: Text;
  /** Petite image de l'élément (adresse data:image/…), montrée à la place de l'initiale (ex. aperçu d'un avatar). */
  preview?: string;
  enabled: boolean;
  /** En service maintenant (modèle chargé, voix utilisée, avatar affiché). */
  active?: boolean;
  status?: ItemStatus;
  statusText?: Text;
  tags?: Text[];
  cloud?: boolean;
  /** Type de l'élément (pour le formulaire de modification). */
  kind?: string;
  /** Valeurs du formulaire. Un secret enregistré vaut SECRET_SET, jamais le secret lui-même. */
  values?: Record<string, unknown>;
  editable?: boolean;
  removable?: boolean;
  /** Peut-on le désactiver ? (faux pour l'élément en service sans remplaçant, par ex.) */
  toggleable?: boolean;
  children?: ItemChild[];
  childrenLabel?: Text;
  /**
   * Boutons propres à l'élément (« Utiliser », « Tester la voix »…). play : l'action rend un son (OpResult.audio) ;
   * la fenêtre la montre en bouton rond « lecture » au début de la ligne.
   */
  actions?: { id: string; label: Text; play?: boolean }[];
  /** Mots qui le désignent à l'oral. */
  aliases?: string[];
  /** Clés des réglages qui appartiennent à cet élément : montrés dans l'élément (« Configurer »), pas dans la rubrique. */
  settings?: string[];
  /**
   * Rubrique rattachée à cet élément (ex. "veille" pour la tâche « Veille du jour ») : la fenêtre la montre dans les
   * réglages de l'élément, et plus dans le menu.
   */
  section?: string;
  /** Groupe de l'élément (ex. le modèle d'une voix). La fenêtre fait choisir le groupe, puis l'élément. */
  group?: { id: string; label: Text; detail?: Text };
  /** Avancement d'un travail en cours (téléchargement), de 0 à 1. La fenêtre montre une barre. */
  progress?: number;
  /** Modèle à télécharger : ce qu'il demande pour tourner. */
  needs?: ModelNeeds;
  /** Modèle à télécharger : taille des fichiers, en octets. */
  size?: number;
  /** Modèle à télécharger : le service que rendra son élément (« vad », « stt », « tts », « llm »). */
  service?: string;
  /** Programme à télécharger : son moteur (« cuda », « vulkan », « metal », « cpu »). */
  backend?: string;
  /** Modèle installé : l'élément offert qu'il donne (id dans ctx.offer du même plugin), à choisir dans un slot. */
  uses?: string;
}

export interface OpResult {
  ok: boolean;
  /** Message pour l'utilisateur : texte simple ou { fr, en } (le noyau choisit la langue de celui qui lit ou écoute). */
  text: Text;
  id?: string;
  children?: ItemChild[];
  /** Après un clic dans la fenêtre : adresse http(s) à ouvrir dans le navigateur (ex. page de connexion). */
  open?: string;
  /** Après un clic dans la fenêtre : texte à copier dans le presse-papiers (ex. code de connexion). */
  copy?: string;
  /** Réponse à une recherche (op « search ») : les éléments trouvés, avec leurs boutons. */
  items?: ItemInfo[];
  /** Après un clic dans la fenêtre : un son à jouer (adresse data:audio/wav, voir wavDataUrl). Ex. l'essai d'une voix. */
  audio?: string;
}

/** Résultat rendu par CatalogRegistry.run : le message est déjà dans la langue de l'origine de la demande. */
export type OpReply = Omit<OpResult, "text"> & { text: string };

export interface ProviderDef {
  /** Unique (ex. "llm-local", "mcp", "voices"). */
  id: string;
  /** Id d'une rubrique (voir sections.ts). Une sous-rubrique (avec `parent`) se montre dans la page de son parent. */
  section: string;
  /**
   * Présentation : "list" (défaut : liste + détail), "grid" (cartes, ex. avatars) ou "library" (ce qu'on peut télécharger :
   * pas montré dans la page, mais dans la bibliothèque ouverte depuis les rôles de `offers`, avec ses boutons d'action).
   */
  layout?: "list" | "grid" | "library";
  /** Capacités libres du fournisseur (ex. "live" : modèle unique qui écoute et parle). Lues par la fenêtre. */
  capabilities?: string[];
  /**
   * Service que ces éléments offrent (ctx.offer, même id d'élément). La fenêtre met un bouton « Activer » sur chaque élément,
   * pour les slots de ce service ; le noyau fait tourner l'élément choisi.
   */
  offers?: string | string[];
  label: Text;
  description?: Text;
  /** Ordre dans la rubrique (petit = haut). */
  order?: number;
  badge?: Text;
  /** Types d'éléments qu'on peut ajouter. Vide = pas d'ajout. */
  kinds?: ItemKind[];
  addLabel?: Text;
  /** Nom des sous-éléments (« Outils donnés au cerveau »). */
  childrenLabel?: Text;
  list(): ItemInfo[] | Promise<ItemInfo[]>;
  add?(kind: string, values: Record<string, unknown>): Promise<OpResult>;
  update?(id: string, values: Record<string, unknown>): Promise<OpResult>;
  remove?(id: string): Promise<OpResult>;
  setEnabled?(id: string, on: boolean): Promise<OpResult>;
  setChild?(id: string, childId: string, on: boolean): Promise<OpResult>;
  /** Essayer avant d'ajouter (id absent) ou un élément existant. */
  test?(kind: string, values: Record<string, unknown>, id?: string): Promise<OpResult>;
  action?(id: string, action: string): Promise<OpResult>;
  /**
   * Recherche en ligne (ex. modèles sur Hugging Face) : rend des éléments avec leurs boutons (`items` du résultat).
   * Les boutons d'un résultat passent par action(id, …) comme ceux de la liste.
   */
  search?(query: string): Promise<OpResult>;
  /** Texte d'aide de la case de recherche (« Chercher sur Hugging Face »). */
  searchHint?: Text;
  /** Ce qui manque pour que ces éléments tournent (ex. « llama-server est introuvable »). Absent : rien ne manque. */
  missing?(): Text | undefined;
  /**
   * Ajout permis à la voix, toujours après un accord (Oui / Non). Seulement pour du code livré avec Floppy dont le
   * formulaire n'a pas de champ obligatoire sans défaut (ex. les applications). Jamais pour un MCP (commande choisie).
   */
  voiceAdd?: boolean;
}

export interface ProviderSnapshot {
  id: string;
  section: string;
  layout: "list" | "grid" | "library";
  capabilities: string[];
  offers?: string | string[];
  label: Text;
  description?: Text;
  order: number;
  badge?: Text;
  kinds: ItemKind[];
  addLabel?: Text;
  childrenLabel?: Text;
  searchHint?: Text;
  missing?: Text;
  source: string;
  can: { add: boolean; update: boolean; remove: boolean; enable: boolean; child: boolean; test: boolean; action: boolean; search: boolean };
  items: ItemInfo[];
  error?: string;
}

export const SECRET_SET = "__secret_set__";

export type CatalogOp =
  | { op: "add"; provider: string; kind: string; values: Record<string, unknown> }
  | { op: "update"; provider: string; id: string; values: Record<string, unknown> }
  | { op: "remove"; provider: string; id: string }
  | { op: "enable"; provider: string; id: string; on: boolean }
  | { op: "child"; provider: string; id: string; child: string; on: boolean }
  | { op: "test"; provider: string; kind: string; values: Record<string, unknown>; id?: string }
  | { op: "action"; provider: string; id: string; action: string }
  | { op: "search"; provider: string; query: string };

/**
 * D'où vient la demande. « voice » : seulement enable (et avec contrôle du risque). « ui » / « cli » : l'hôte seulement.
 * « assistant » : un plugin, après l'accord de l'utilisateur à l'écran (cloud : accord redemandé).
 */
export type CatalogVia = "ui" | "cli" | "voice" | "assistant";

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export class CatalogRegistry {
  private defs = new Map<string, { def: ProviderDef; source: string }>();
  private listeners = new Set<() => void>();
  private readonly approvals: ApprovalManager;
  private readonly audit: Audit;

  /** Langue d'une réponse selon l'origine : interface (ui, cli) ou assistant (voice, assistant). */
  private readonly lang: (via: CatalogVia) => string;

  constructor(approvals: ApprovalManager, audit: Audit, lang: (via: CatalogVia) => string = () => "fr") {
    this.approvals = approvals;
    this.audit = audit;
    this.lang = lang;
  }

  declare(source: string, def: ProviderDef): () => void {
    const cur = this.defs.get(def.id);
    if (cur) throw new Error(`fournisseur ${def.id} déjà déclaré par ${cur.source}`);
    const entry = { def, source };
    this.defs.set(def.id, entry);
    this.changed();
    return () => {
      if (this.defs.get(def.id) === entry) this.defs.delete(def.id);
      this.changed();
    };
  }

  provider(id: string): ProviderDef | undefined {
    return this.defs.get(id)?.def;
  }

  /** Rubriques des fournisseurs déclarés maintenant (sans interroger leurs listes). */
  sections(): string[] {
    return [...new Set([...this.defs.values()].map((e) => e.def.section))].sort();
  }

  async snapshot(): Promise<ProviderSnapshot[]> {
    const out: ProviderSnapshot[] = [];
    for (const { def, source } of this.defs.values()) {
      let items: ItemInfo[] = [];
      let error: string | undefined;
      try { items = await def.list(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      let missing: Text | undefined;
      try { missing = def.missing?.(); } catch { /* lu au prochain instantané */ }
      out.push({
        id: def.id, section: def.section, layout: def.layout ?? "list", capabilities: def.capabilities ?? [], ...(def.offers ? { offers: def.offers } : {}), label: def.label, order: def.order ?? 100, source,
        ...(def.description ? { description: def.description } : {}),
        ...(def.badge ? { badge: def.badge } : {}),
        kinds: def.kinds ?? [],
        ...(def.addLabel ? { addLabel: def.addLabel } : {}),
        ...(def.childrenLabel ? { childrenLabel: def.childrenLabel } : {}),
        ...(def.searchHint ? { searchHint: def.searchHint } : {}),
        ...(missing ? { missing } : {}),
        can: {
          add: !!def.add && (def.kinds?.length ?? 0) > 0, update: !!def.update, remove: !!def.remove,
          enable: !!def.setEnabled, child: !!def.setChild, test: !!def.test, action: !!def.action, search: !!def.search,
        },
        items,
        ...(error ? { error } : {}),
      });
    }
    return out.sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order);
  }

  /** Exécute une opération. Le contrôle de l'origine est fait ici (le modèle ne peut pas le contourner). */
  async run(o: CatalogOp, via: CatalogVia, origin?: string): Promise<OpReply> {
    const r = await this.runRaw(o, via, origin);
    return { ...r, text: tr(r.text, this.lang(via)) };
  }

  private async runRaw(o: CatalogOp, via: CatalogVia, origin?: string): Promise<OpResult> {
    const entry = this.defs.get(o.provider);
    if (!entry) return { ok: false, text: T(`Fournisseur inconnu : ${o.provider}.`, `Unknown provider: ${o.provider}.`) };
    const { def } = entry;
    if (via === "voice" && !(o.op === "enable" || (o.op === "add" && def.voiceAdd))) {
      this.audit.write({ kind: "catalog.refused", op: o.op, provider: o.provider, why: "pas à la voix" });
      return { ok: false, text: T("Ça ne se fait pas à la voix, pour ta sécurité : utilise la fenêtre des réglages.", "This can't be done by voice, for your safety: use the Settings window.") };
    }
    let r: OpResult;
    try {
      switch (o.op) {
        case "add": {
          if (!def.add) return { ok: false, text: T("Ce fournisseur ne permet pas d'ajouter.", "This provider does not allow adding.") };
          const kind = def.kinds?.find((k) => k.id === o.kind);
          if (!kind) return { ok: false, text: T(`Type inconnu : ${o.kind}.`, `Unknown type: ${o.kind}.`) };
          // À la voix : seulement les valeurs par défaut (le modèle ne remplit pas le formulaire).
          const values = via === "voice" ? defaults(kind.fields) : o.values;
          const miss = missing(kind.fields, values);
          if (miss.length) {
            return via === "voice"
              ? { ok: false, text: T(`${tr(kind.label, "fr")} demande des réglages (${miss.join(", ")}) : ajoute-le dans la fenêtre des réglages. Rien n'a changé.`, `${tr(kind.label, "en")} needs settings (${miss.join(", ")}): add it in the Settings window. Nothing changed.`) }
              : { ok: false, text: T(`À remplir : ${miss.join(", ")}.`, `Required: ${miss.join(", ")}.`) };
          }
          if (via === "voice") {
            const cloud = kind.cloud ? T(" (données dans le cloud)", " (data goes to the cloud)") : undefined;
            const d = await this.approvals.check({
              tool: "ajouter_application", args: { fournisseur: o.provider, type: o.kind }, level: "write", override: "ask",
              summary: T(`Ajouter ${tr(kind.label, "fr")}${cloud ? tr(cloud, "fr") : ""}`, `Add ${tr(kind.label, "en")}${cloud ? tr(cloud, "en") : ""}`), ...(origin ? { origin } : {}),
            });
            if (!d.ok) return { ok: false, text: T("Refusé par l'utilisateur. Rien n'a changé. Ne le retente pas.", "Refused by the user. Nothing changed. Do not try again.") };
          }
          r = await def.add(o.kind, values);
          break;
        }
        case "update":
          if (!def.update) return { ok: false, text: T("Ce fournisseur ne permet pas de modifier.", "This provider does not allow editing.") };
          r = await def.update(o.id, o.values);
          break;
        case "remove":
          if (!def.remove) return { ok: false, text: T("Ce fournisseur ne permet pas de supprimer.", "This provider does not allow removing.") };
          r = await def.remove(o.id);
          break;
        case "enable": {
          if (!def.setEnabled) return { ok: false, text: T("Cet élément ne se désactive pas.", "This item cannot be disabled.") };
          const item = (await def.list()).find((i) => i.id === o.id);
          if (!o.on && item?.toggleable === false) {
            return { ok: false, text: T(`${tr(item.label, "fr")} ne peut pas être désactivé (en service, sans remplaçant).`, `${tr(item.label, "en")} cannot be disabled (in use, no replacement).`) };
          }
          if ((via === "voice" || via === "assistant") && o.on) {
            // Élément introuvable : on refuse (on ne peut pas savoir s'il part dans le cloud).
            if (!item) return { ok: false, text: T(`Élément introuvable : ${o.id}. Rien n'a changé.`, `Item not found: ${o.id}. Nothing changed.`) };
            if (item.cloud) {
              // override « ask » : la règle « write: always » ne dispense pas de demander pour le cloud.
              const d = await this.approvals.check({
                tool: "activer_element", args: { fournisseur: o.provider, element: o.id }, level: "write", override: "ask",
                summary: T(`Activer ${tr(item.label, "fr")} (données dans le cloud)`, `Turn on ${tr(item.label, "en")} (data goes to the cloud)`), ...(origin ? { origin } : {}),
              });
              if (!d.ok) return { ok: false, text: T("Refusé par l'utilisateur. Rien n'a changé. Ne le retente pas.", "Refused by the user. Nothing changed. Do not try again.") };
            }
          }
          r = await def.setEnabled(o.id, o.on);
          break;
        }
        case "child":
          if (!def.setChild) return { ok: false, text: T("Pas de sous-élément ici.", "No sub-item here.") };
          r = await def.setChild(o.id, o.child, o.on);
          break;
        case "test":
          if (!def.test) return { ok: false, text: T("Pas de test possible ici.", "Nothing to test here.") };
          r = await def.test(o.kind, o.values, o.id);
          break;
        case "action":
          if (!def.action) return { ok: false, text: T("Pas d'action ici.", "No action here.") };
          r = await def.action(o.id, o.action);
          break;
        case "search":
          if (!def.search) return { ok: false, text: T("Pas de recherche ici.", "No search here.") };
          r = await def.search(String(o.query ?? "").slice(0, 200));
          break;
      }
    } catch (e) {
      r = { ok: false, text: errorText(e) };
    }
    // Essayer et chercher ne changent rien : ni journal, ni mise à jour de la fenêtre.
    if (o.op !== "test" && o.op !== "search") {
      this.audit.write({
        kind: "catalog", op: o.op, provider: o.provider, via, ok: r.ok,
        ...("id" in o && o.id ? { id: o.id } : {}), ...(r.id ? { newId: r.id } : {}),
        ...(o.op === "enable" || o.op === "child" ? { on: o.on } : {}),
        ...(o.op === "child" ? { child: o.child } : {}),
        ...(o.op === "action" ? { action: o.action } : {}),
      });
      this.changed();
    }
    return r;
  }

  /** Trouve un type qu'on peut ajouter à la voix (fournisseurs `voiceAdd`), par son nom dit à l'oral (« Orca »). */
  findKind(name: string): { provider: string; kind: ItemKind }[] {
    const n = norm(name);
    const out: { provider: string; kind: ItemKind; score: number }[] = [];
    for (const { def } of this.defs.values()) {
      if (!def.voiceAdd || !def.add) continue;
      for (const kind of def.kinds ?? []) {
        const score = matchScore(n, [kind.id, ...allTexts(kind.label), ...(kind.aliases ?? [])]);
        if (score) out.push({ provider: def.id, kind, score });
      }
    }
    const best = Math.max(0, ...out.map((o) => o.score));
    return out.filter((o) => o.score === best).map(({ provider, kind }) => ({ provider, kind }));
  }

  /** Trouve un élément par son nom dit à l'oral (« Qwen », « Azure DevOps »). */
  async find(name: string, section?: string): Promise<{ provider: string; item: ItemInfo }[]> {
    const n = norm(name);
    const out: { provider: string; item: ItemInfo; score: number }[] = [];
    for (const { def } of this.defs.values()) {
      if (section && def.section !== section) continue;
      let items: ItemInfo[];
      try { items = await def.list(); } catch { continue; }
      for (const item of items) {
        const score = matchScore(n, [item.id, ...allTexts(item.label), ...(item.aliases ?? [])]);
        if (score) out.push({ provider: def.id, item, score });
      }
    }
    const best = Math.max(0, ...out.map((o) => o.score));
    return out.filter((o) => o.score === best).map(({ provider, item }) => ({ provider, item }));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Un fournisseur signale que sa liste a changé (modèle chargé, connecteur connecté…). */
  changed(): void {
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* rien */ } }
  }
}

/** 2 : nom exact ; 1 : l'un contient l'autre ; 0 : rien. `n` est déjà normalisé. */
function matchScore(n: string, names: string[]): number {
  const all = names.map(norm);
  return all.includes(n) ? 2 : all.some((x) => x.includes(n) || (x.length > 2 && n.includes(x))) ? 1 : 0;
}

/** Valeurs par défaut d'un formulaire. */
function defaults(fields: FieldDef[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
}

function missing(fields: FieldDef[], values: Record<string, unknown>): string[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    if (f.showIf && !f.showIf.values.includes(values[f.showIf.key])) return false;
    const v = values[f.key];
    return v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
  }).map((f) => tr(f.label));
}

// --------------------------------------------------------------------------- ItemStore

/** Ce que l'utilisateur a changé, par-dessus les éléments de la config (floppy.yml n'est jamais réécrit). */
export interface ItemOverlay<V = Record<string, unknown>> {
  /** Éléments ajoutés : id → { kind, values }. */
  added: Record<string, { kind: string; values: V }>;
  /** Éléments de la config modifiés : id → valeurs qui remplacent. */
  edits: Record<string, Partial<V>>;
  /** Ids désactivés (gardés). */
  disabled: string[];
  /** Ids de la config supprimés. */
  removed: string[];
  /** Sous-éléments : id → childId → actif. */
  children: Record<string, Record<string, boolean>>;
  /** Données libres du fournisseur. */
  extra: Record<string, unknown>;
}

export class ItemStore<V = Record<string, unknown>> {
  readonly file: string;
  data: ItemOverlay<V>;

  constructor(file: string) {
    this.file = file;
    const empty: ItemOverlay<V> = { added: {}, edits: {}, disabled: [], removed: [], children: {}, extra: {} };
    try {
      this.data = existsSync(file) ? { ...empty, ...JSON.parse(readFileSync(file, "utf8")) } : empty;
    } catch {
      this.data = empty;
    }
  }

  static in(home: string, name: string): ItemStore {
    return new ItemStore(join(home, "items", `${name.replace(/[^a-z0-9_-]/gi, "_")}.json`));
  }

  isEnabled(id: string): boolean {
    return !this.data.disabled.includes(id);
  }

  setEnabled(id: string, on: boolean): void {
    this.data.disabled = this.data.disabled.filter((x) => x !== id);
    if (!on) this.data.disabled.push(id);
    this.save();
  }

  /** Fusionne les éléments de la config avec les ajouts et les modifications de l'utilisateur. */
  merge(base: Record<string, V>): Record<string, V & { _added?: boolean }> {
    const out: Record<string, V & { _added?: boolean }> = {};
    for (const [id, v] of Object.entries(base)) {
      if (this.data.removed.includes(id)) continue;
      out[id] = { ...v, ...(this.data.edits[id] ?? {}) } as V & { _added?: boolean };
    }
    for (const [id, a] of Object.entries(this.data.added)) out[id] = { ...a.values, _added: true } as V & { _added?: boolean };
    return out;
  }

  add(kind: string, values: V, wantId: string, taken: Iterable<string> = []): string {
    const used = new Set([...taken, ...Object.keys(this.data.added)]);
    let id = slug(wantId) || "element";
    for (let i = 2; used.has(id); i++) id = `${slug(wantId)}-${i}`;
    this.data.added[id] = { kind, values };
    this.data.removed = this.data.removed.filter((x) => x !== id);
    this.save();
    return id;
  }

  update(id: string, values: Partial<V>): void {
    const a = this.data.added[id];
    if (a) a.values = { ...a.values, ...values };
    else this.data.edits[id] = { ...(this.data.edits[id] ?? {}), ...values };
    this.save();
  }

  remove(id: string): void {
    if (this.data.added[id]) delete this.data.added[id];
    else if (!this.data.removed.includes(id)) this.data.removed.push(id);
    delete this.data.edits[id];
    delete this.data.children[id];
    this.data.disabled = this.data.disabled.filter((x) => x !== id);
    this.save();
  }

  isAdded(id: string): boolean {
    return !!this.data.added[id];
  }

  child(id: string, childId: string): boolean | undefined {
    return this.data.children[id]?.[childId];
  }

  setChild(id: string, childId: string, on: boolean): void {
    (this.data.children[id] ??= {})[childId] = on;
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }
}

export function slug(s: string): string {
  return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
