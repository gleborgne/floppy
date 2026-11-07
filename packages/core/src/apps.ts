// Applications : des plugins que l'utilisateur ajoute ou retire lui-même depuis la fenêtre des réglages
// (Orca, ouvrir le navigateur…). Un plugin le devient en déclarant `manifest.addable` :
//
//   addable: { section: "connecteurs", label: { fr: "Navigateur", en: "Browser" }, fields: [...] }
//
// Pour chaque rubrique qui a de tels plugins, le noyau montre un fournisseur « Applications » :
// - ses types d'ajout = les plugins installables de la rubrique (formulaire tiré de `fields` = config de l'entrée) ;
// - ses éléments = les entrées de ces plugins (celles d'floppy.yml + celles ajoutées) ;
// - désactiver = l'entrée s'arrête (ses outils disparaissent) ; supprimer = l'entrée est retirée ;
// - sous-éléments = les outils de l'entrée ; décocher = outil caché au cerveau.
// Les choix sont gardés dans <home>/items/apps.json ; floppy.yml n'est jamais réécrit.
import type { CatalogRegistry, ItemChild, ItemInfo, OpResult, ProviderDef } from "./catalog.ts";
import { ItemStore, slug } from "./catalog.ts";
import type { EntryConfig, Level } from "./config/schema.ts";
import type { Manifest } from "./plugin/manifest.ts";
import type { ToolRegistry } from "./tools.ts";
import { tr, type Text } from "./i18n.ts";
import type { PluginState } from "./bus.ts";
import { cleanLogo, type Logo } from "./logo.ts";

export interface AppsHost {
  home: string;
  items: CatalogRegistry;
  tools: ToolRegistry;
  manifests(): Manifest[];
  /** Entrées de la config du fichier (avant les choix de l'utilisateur). */
  baseEntries(): EntryConfig[];
  entryState(id: string): { state: PluginState; error?: Text } | undefined;
  entryNote(id: string): { text: Text; tone?: "ok" | "warn" | "error" } | undefined;
  /** Logo donné par le plugin qui tourne (ctx.items.logo) ; null : aucun ; undefined : celui du manifeste. */
  entryLogo(id: string): Logo | null | undefined;
  /** Clés des réglages déclarés par l'entrée. */
  entrySettings(id: string): string[];
  entryActions(id: string): { list: { id: string; label: Text }[]; run: (action: string) => Promise<OpResult> } | undefined;
  /** Installe la transformation des entrées du fichier et réapplique la config. */
  setTransform(fn: (base: EntryConfig[]) => EntryConfig[]): Promise<void>;
}

const t = (fr: string, en: string): Text => ({ fr, en });

const LEVEL_TAG: Record<Level, Text> = {
  read: t("lecture · libre", "read · free"),
  write: t("écriture · accord", "write · approval"),
  send: t("envoi · accord", "send · approval"),
  delete: t("suppression · accord", "delete · approval"),
  physical: t("physique · accord", "physical · approval"),
};

export class Apps {
  private readonly host: AppsHost;
  private readonly store: ItemStore;
  private readonly declared = new Map<string, () => void>();

  constructor(host: AppsHost) {
    this.host = host;
    this.store = ItemStore.in(host.home, "apps");
    void host.setTransform((base) => this.transform(base));
    this.applyHidden();
    host.tools.onChange(() => { this.rememberTools(); host.items.changed(); });
  }

  /** À appeler quand un plugin est enregistré : déclare le fournisseur de sa rubrique si besoin. */
  refresh(): void {
    const sections = new Set(this.host.manifests().filter((m) => m.addable).map((m) => m.addable!.section));
    for (const s of sections) if (!this.declared.has(s)) this.declared.set(s, this.host.items.declare("core", this.provider(s)));
  }

  private addable(plugin: string): Manifest | undefined {
    return this.host.manifests().find((m) => m.id === plugin && m.addable);
  }

  private transform(base: EntryConfig[]): EntryConfig[] {
    const d = this.store.data;
    const out: EntryConfig[] = [];
    for (const e of base) {
      if (!this.addable(e.plugin)) { out.push(e); continue; }
      if (d.removed.includes(e.id)) continue;
      const edits = d.edits[e.id];
      out.push({
        ...e,
        disabled: e.disabled || d.disabled.includes(e.id),
        ...(edits ? { config: { ...((e.config as Record<string, unknown> | undefined) ?? {}), ...edits } } : {}),
      });
    }
    const taken = new Set(out.map((e) => e.id));
    for (const [id, a] of Object.entries(d.added)) {
      if (taken.has(id)) continue;
      out.push({ id, plugin: a.kind, config: a.values, disabled: d.disabled.includes(id) });
    }
    return out;
  }

  private entries(section: string): EntryConfig[] {
    return this.transform(this.host.baseEntries()).filter((e) => this.addable(e.plugin)?.addable?.section === section);
  }

  private apply(): Promise<void> {
    return this.host.setTransform((base) => this.transform(base));
  }

  /** Outils cachés : décochés dans un élément. */
  private applyHidden(): void {
    const hidden = new Set<string>();
    for (const tools of Object.values(this.store.data.children)) {
      for (const [name, on] of Object.entries(tools)) if (on === false) hidden.add(name);
    }
    this.host.tools.setHidden(hidden);
  }

  /** Garde les outils de chaque entrée : une entrée éteinte montre encore ses outils. */
  private rememberTools(): void {
    const all = this.host.tools.listAll();
    const known = (this.store.data.extra.tools ??= {}) as Record<string, { name: string; level: Level; description: string }[]>;
    let dirty = false;
    for (const e of this.transform(this.host.baseEntries())) {
      if (!this.addable(e.plugin)) continue;
      const mine = all.filter((x) => x.source === e.id).map((x) => ({ name: x.name, level: x.level, description: x.description.split(".")[0] ?? "" }));
      if (!mine.length) continue;
      if (JSON.stringify(known[e.id]) !== JSON.stringify(mine)) { known[e.id] = mine; dirty = true; }
    }
    if (dirty) this.store.save();
  }

  private children(id: string): ItemChild[] {
    const known = ((this.store.data.extra.tools ?? {}) as Record<string, { name: string; level: Level; description: string }[]>)[id] ?? [];
    return known.map((x) => ({
      id: x.name, label: x.name, detail: x.description, enabled: this.store.child(id, x.name) ?? true,
      tag: LEVEL_TAG[x.level], tone: x.level === "read" ? "ok" as const : "warn" as const,
    }));
  }

  private info(e: EntryConfig, many: boolean): ItemInfo {
    const m = this.addable(e.plugin)!;
    const a = m.addable!;
    const st = this.host.entryState(e.id);
    const note = this.host.entryNote(e.id);
    const off = e.disabled;
    const status = off ? "off" : st?.state === "error" ? "error" : st?.state === "waiting" ? "warn" : note?.tone === "warn" ? "warn" : st?.state === "active" ? "ok" : "loading";
    const statusText: Text = off ? t("éteint", "off")
      : st?.state === "error" ? t(`erreur : ${tr(st.error, "fr")}`, `error: ${tr(st.error, "en")}`)
      : st?.state === "waiting" ? t("en attente", "waiting")
      : note?.text ?? (st?.state === "active" ? t("actif", "on") : t("démarrage…", "starting…"));
    const withId = (l: string): string => `${l} (${e.id})`;
    const given = off ? undefined : this.host.entryLogo(e.id);
    const logo = given === undefined ? cleanLogo(a.logo) : given ?? undefined;
    return {
      id: e.id,
      label: many ? (typeof a.label === "string" ? withId(a.label) : t(withId(tr(a.label, "fr")), withId(tr(a.label, "en")))) : a.label,
      ...(a.description ? { detail: a.description } : {}),
      ...(logo ? { logo } : {}),
      enabled: !off, status, statusText, tags: ["application"],
      ...(a.cloud ? { cloud: true } : {}),
      kind: m.id,
      values: (e.config as Record<string, unknown> | undefined) ?? {},
      editable: (a.fields?.length ?? 0) > 0, removable: true, toggleable: true,
      children: this.children(e.id),
      ...(this.host.entrySettings(e.id).length ? { settings: this.host.entrySettings(e.id) } : {}),
      ...(!off && this.host.entryActions(e.id)?.list.length ? { actions: this.host.entryActions(e.id)!.list } : {}),
      aliases: [m.id, e.id, ...(a.aliases ?? [])],
    };
  }

  private provider(section: string): ProviderDef {
    const self = this;
    return {
      id: `apps-${section}`,
      section,
      label: t("Applications", "Applications"),
      description: t("Plugins que tu ajoutes ou retires toi-même.", "Plugins you add or remove yourself."),
      order: 60,
      // Code livré avec Floppy : « ajoute Orca » marche à la voix, après un accord (voir CatalogRegistry.run).
      voiceAdd: true,
      childrenLabel: t("Outils donnés au cerveau", "Tools given to the brain"),
      get kinds() {
        return self.kinds(section);
      },
      list: () => {
        const list = this.entries(section);
        return list.map((e) => this.info(e, list.filter((x) => x.plugin === e.plugin).length > 1));
      },
      add: async (kind, values) => {
        const m = this.addable(kind);
        if (!m || m.addable!.section !== section) return { ok: false, text: t("Application inconnue.", "Unknown app.") };
        const all = this.transform(this.host.baseEntries());
        if (m.addable!.single && all.some((e) => e.plugin === kind)) return { ok: false, text: t("Cette application est déjà ajoutée.", "This app is already added.") };
        const taken = [...this.host.baseEntries().map((e) => e.id), ...all.map((e) => e.id)];
        const id = this.store.add(kind, values, slug(kind), taken);
        await this.apply();
        return { ok: true, text: t("Application ajoutée.", "App added."), id };
      },
      update: async (id, values) => {
        if (!this.entries(section).some((e) => e.id === id)) return { ok: false, text: t("Élément inconnu.", "Unknown item.") };
        this.store.update(id, values);
        await this.apply();
        return { ok: true, text: t("Modifié.", "Saved.") };
      },
      remove: async (id) => {
        if (!this.entries(section).some((e) => e.id === id)) return { ok: false, text: t("Élément inconnu.", "Unknown item.") };
        this.store.remove(id);
        delete (this.store.data.extra.tools as Record<string, unknown> | undefined)?.[id];
        this.store.save();
        this.applyHidden();
        await this.apply();
        return { ok: true, text: t("Application retirée.", "App removed.") };
      },
      setEnabled: async (id, on) => {
        if (!this.entries(section).some((e) => e.id === id)) return { ok: false, text: t("Élément inconnu.", "Unknown item.") };
        this.store.setEnabled(id, on);
        await this.apply();
        return { ok: true, text: on ? t("Allumé.", "Turned on.") : t("Éteint.", "Turned off.") };
      },
      action: async (id, action) => {
        const a = this.host.entryActions(id);
        if (!a || !a.list.some((x) => x.id === action)) return { ok: false, text: t("Action inconnue.", "Unknown action.") };
        return a.run(action);
      },
      setChild: async (id, child, on) => {
        this.store.setChild(id, child, on);
        this.applyHidden();
        return { ok: true, text: on ? t("Outil donné au cerveau.", "Tool given to the brain.") : t("Outil retiré.", "Tool removed.") };
      },
    };
  }

  /** Types d'ajout de la rubrique (relus à chaque fois : un plugin enregistré plus tard apparaît). */
  kinds(section: string) {
    return this.host.manifests().filter((m) => m.addable?.section === section).map((m) => ({
      id: m.id, label: m.addable!.label,
      ...(m.addable!.description ? { description: m.addable!.description } : {}),
      fields: m.addable!.fields ?? [],
      ...(m.addable!.cloud ? { cloud: true } : {}),
      ...(m.provides?.length ? { provides: [...m.provides] } : {}),
      ...(m.addable!.aliases?.length ? { aliases: [...m.addable!.aliases] } : {}),
      ...(m.addable!.single ? { single: true } : {}),
    }));
  }
}
