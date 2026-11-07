// Fenêtre des réglages : les pages à slots (Cerveau, Voix, Écoute…). Même grammaire partout : « Activer » met un
// élément en service, le badge « en service » le montre, sa page règle ses réglages, l'interrupteur « Actif » est
// seulement sur un plugin. Tout vient des déclarations : slots du noyau, fournisseurs d'éléments (offers) et
// applications (plugins qu'on ajoute, allume, éteint ou retire).
import { h } from "./dom.ts";
import type { Child, Ev } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { chainOf } from "./form-rules.ts";
import { librariesFor } from "./library.ts";
import { entryOf, offersOf, slotSources } from "./slot-sources.ts";
import { settingsBlocks } from "./settings-controls.ts";
import { libButton, openCatalogue, openItemSettings, roleOf } from "./settings-dialogs.ts";
import { inlineForm } from "./settings-form.ts";
import { addButtons, addPluginBtn, avatarGrid, inUseBadge, itemRow, noneRow, optionRow, providerCard, row, secHead } from "./settings-rows.ts";
import {
  S, appProviders, modeSlotOf, pageOf, quickOp, render, secLabel, slotLabelOf, slotSetting, slotStateText, slotsOn, t, tr, uiTab, valueOf,
} from "./settings-state.ts";

/** L'application (plugin installé) d'une entrée : [fournisseur « apps-… », élément]. */
function appOf(source: string): [ItemProvider, ProviderItem] | null {
  for (const p of appProviders()) { const it = p.items.find((x) => x.id === source); if (it) return [p, it]; }
  return null;
}
/** Plugins qui offrent un service : [entrée, ses fournisseurs d'éléments]. */
function pluginsFor(service: string): [string, ItemProvider[]][] {
  const m = new Map<string, ItemProvider[]>();
  for (const p of S.items.providers) {
    if (!offersOf(p).includes(service)) continue;
    const source = p.source ?? "";
    const list = m.get(source) ?? [];
    list.push(p);
    m.set(source, list);
  }
  return [...m];
}
const pluginName = (source: string, provs: ItemProvider[]): string => tr(appOf(source)?.[1].label) || tr(provs[0]?.label) || source;
/** Tous les plugins d'un slot (fournisseurs, plugins installés même éteints, choix offerts par ctx.offer seul). */
const sourcesOf = (slot: SettingsSlot) => slotSources(S.items.providers, slotSetting(slot)?.options ?? [], slot.service);
/**
 * Choix d'un slot qu'aucune fiche du catalogue ne montre (ex. « Claude Sonnet » pour le tri : offert par le plugin Claude,
 * dont la fiche montre le cerveau). Tirés des options du réglage du slot, groupés par entrée : [entrée, options].
 */
const looseOptions = (slot: SettingsSlot): [string, SettingOption[]][] => sourcesOf(slot).filter((x) => x.options.length).map((x) => [x.source, x.options]);

/** Slots de la page en cours qui forment une chaîne (voir chainOf) : slot -> n° d'étape. */
let chainNow = new Map<string, number>();
/** Onglet « étape » d'un slot de la chaîne : son n° et ce qui est en service. */
function stepAttrs(slot: SettingsSlot): Record<string, string> {
  const n = chainNow.get(slot.id);
  return n ? { "data-step": String(n), "data-step-value": slotLabelOf(slot) } : {};
}

/** Un slot en liste, groupée par plugin (ex. cerveau principal, délégation). */
function slotList(slot: SettingsSlot, page: string, { withNone = true, title, sub }: { withNone?: boolean; title?: string; sub?: string } = {}): VNode {
  const plugins = pluginsFor(slot.service).map(([source, provs]): [string, ItemProvider[], [ItemProvider, ProviderItem][]] => [source, provs, provs.flatMap((p) => p.items.map((it): [ItemProvider, ProviderItem] => [p, it]))]).filter(([, , rows]) => rows.length);
  // Titre de groupe seulement s'il apporte quelque chose : un plugin qui a un seul élément porte déjà son nom.
  const headers = plugins.some(([, , rows]) => rows.length > 1);
  const loose = looseOptions(slot);
  const groups = plugins.length + loose.length;
  const kids: Child[] = [];
  for (const [source, provs, rows] of plugins) {
    if (headers || (groups > 1 && loose.length && rows.length > 1)) kids.push(h("div", { class: "sgrp", key: `g:${source}`, text: pluginName(source, provs) }));
    for (const [p, it] of rows) kids.push(itemRow(slot, p, it, page));
  }
  for (const [source, opts] of loose) {
    if (groups > 1 && opts.length > 1) kids.push(h("div", { class: "sgrp", key: `g:${source}`, text: pluginName(source, []) }));
    for (const o of opts) kids.push(optionRow(slot, o, page));
  }
  if (withNone && slot.none) kids.push(noneRow(slot, page));
  if (!kids.length) kids.push(h("div", { class: "empty-line", text: t("noItems") }));
  return h("section", { class: "ssec", "data-tab": title ?? tr(slot.label), ...stepAttrs(slot) },
    secHead(title ?? tr(slot.label), sub ?? tr(slot.description)), h("div", { class: "scard" }, kids), slotAddBar(slot, page));
}

/**
 * Sous la liste d'un slot : « + Ajouter … » de chaque plugin installé qui peut ajouter un élément pour ce rôle
 * (ex. un modèle local), et « + Ajouter un plugin » (le catalogue : Codex, Antigravity, une API…).
 */
function slotAddBar(slot: SettingsSlot, page: string): VNode {
  const btns = pluginsFor(slot.service).flatMap(([, provs]) => provs.flatMap(addButtons));
  if (librariesFor(S.libraries, slot.service).length) btns.push(libButton(slot.service, "", tr(slot.label)));
  btns.push(addPluginBtn(page, roleOf(slot)));
  return h("div", { class: "saddbar" }, btns);
}

/** Bandeau d'un plugin : description, « + Ajouter … », Réglages, interrupteur Actif. */
function pluginHead(source: string, provs: ItemProvider[], service: string, roleLabel: string, page: string): VNode | null {
  const app = appOf(source);
  const text = tr(app?.[1].detail) || tr(provs[0]?.description);
  const btns = provs.flatMap(addButtons);
  if (service && librariesFor(S.libraries, service, source).length) btns.push(libButton(service, source, roleLabel));
  // Retirer / Actif sont dans l'onglet Plugins quand la page en a un : ici, seulement pour rallumer un plugin éteint.
  if (app && (!app[1].enabled || !hasPluginsTab(page))) { const c = pluginControls(app[0], app[1]); btns.push(...c.acts, ...c.sw); }
  // Rien à faire : la description seule, sans carte.
  if (!btns.length) return text ? h("p", { class: "ddesc pdesc", text }) : null;
  return h("div", { class: "scard phead" }, h("p", { text }), btns);
}
/** La page a-t-elle un onglet Plugins (au moins un slot montré en liste) ? */
const hasPluginsTab = (page: string): boolean => !!page && slotsOn(page).some((x) => x.display !== "tabs" && x.display !== "mode");

/**
 * Commandes d'un plugin (application) : « Réglages » seulement s'il a un formulaire, « Retirer » (2 clics : le 2e
 * confirme), et l'interrupteur « Actif ». Retirer ne supprime rien sur le disque : le plugin revient par « + Ajouter un plugin ».
 */
function pluginControls(ap: ItemProvider, it: ProviderItem): { acts: VNode[]; sw: VNode[] } {
  const acts: VNode[] = [];
  if (it.editable) acts.push(h("button", { type: "button", class: "btn small", key: "settings", text: t("settingsBtn"), onclick: () => openItemSettings(ap, it) }));
  if (ap.can.remove && it.removable !== false) {
    const k = `${ap.id}/${it.id}`;
    const sure = S.removing === k;
    acts.push(h("button", {
      type: "button", class: `btn small${sure ? " danger" : ""}`, key: "remove", text: sure ? t("removePluginSure") : t("removePlugin"), title: t("removePluginTip"),
      onclick: async () => {
        if (!sure) { S.removing = k; render(); setTimeout(() => { if (S.removing === k) { S.removing = ""; render(); } }, 5000); return; }
        S.removing = "";
        await quickOp({ op: "remove", provider: ap.id, id: it.id });
      },
    }));
  }
  const sw = [
    h("span", { class: "swl", key: "swl", text: t("onShort") }),
    h("button", { type: "button", class: "sw", role: "switch", key: "sw", "aria-checked": String(!!it.enabled), "aria-label": `${tr(it.label)} : ${t("onShort")}`, onclick: () => quickOp({ op: "enable", provider: ap.id, id: it.id, on: !it.enabled }) }, h("i")),
  ];
  return { acts, sw };
}

/** Les plugins qui apportent les éléments d'un ou plusieurs services, et « + Ajouter un plugin ». */
function pluginCards(services: string[], page: string, title: string): VNode {
  const seen = new Set<string>();
  const extra = (s: string): [string, ItemProvider[]][] => (S.settings.slots ?? []).filter((x) => x.service === s).flatMap((x) => looseOptions(x).map(([e]): [string, ItemProvider[]] => [e, []]));
  const own = appProviders().filter((ap) => ap.section === page).flatMap((ap) => ap.items.map((it): [string, ItemProvider[]] => [it.id, []]));
  const cards: VNode[] = [];
  for (const [source, provs] of [...own, ...services.flatMap((s) => [...pluginsFor(s), ...extra(s)])]) {
    if (seen.has(source)) continue;
    seen.add(source);
    const app = appOf(source);
    const c = app ? pluginControls(app[0], app[1]) : { acts: [], sw: [] };
    // Ligne 1 : nom, « intégré », interrupteur Actif. Ligne 2 : « + Ajouter … », Réglages.
    cards.push(h("div", { class: "scard pcard", key: source },
      h("div", { class: "pctop" }, h("strong", { text: pluginName(source, provs) }), h("span", { class: "chip", text: t("builtin") }), c.sw),
      h("div", { class: "pcacts" }, provs.flatMap(addButtons), c.acts)));
  }
  cards.push(addPluginBtn(page, { services: slotsOn(page).map((x) => x.service), label: secLabel(page) }, "addcard"));
  return h("section", { class: "ssec", "data-tab": title }, secHead(title, t("pluginsNote")), h("div", { class: "pgrid" }, cards));
}

/** Un slot en onglets, un par plugin (ex. Voix, mot d'activation). */
function slotTabs(slot: SettingsSlot, page: string): VNode {
  const plugins = sourcesOf(slot);
  const active = entryOf(slot.value);
  const ids = [...plugins.map((x) => x.source), ...(slot.none ? ["@none"] : [])];
  let cur = uiTab.get(slot.id) ?? "";
  if (!ids.includes(cur)) cur = ids.includes(active) ? active : ids[0] ?? "";
  const tabBtn = (id: string, label: Child | string, extra?: Child) => h("button", { type: "button", role: "tab", key: id, class: `stab${id === cur ? " on" : ""}`, "aria-selected": String(id === cur), onclick: () => { uiTab.set(slot.id, id); render(); } }, label, extra);
  const tabs = plugins.map(({ source, provs }) => {
    const app = appOf(source)?.[1];
    const bad = (it: ProviderItem) => it.enabled && (it.status === "warn" || it.status === "error");
    const warn = provs.some((p) => p.items.some(bad)) || (app && bad(app));
    return tabBtn(source, pluginName(source, provs), source === active ? inUseBadge() : warn ? h("span", { class: "wdot", "aria-label": t("needsSetup") }) : null);
  });
  if (slot.none) tabs.push(tabBtn("@none", tr(slot.none), active === "@none" ? inUseBadge() : null));
  tabs.push(h("button", { type: "button", class: "stab add", key: "+", text: `+ ${t("addPlugin")}`, onclick: () => openCatalogue(page, roleOf(slot)) }));
  const panel: Child[] = [];
  if (cur === "@none") panel.push(h("div", { class: "scard" }, noneRow(slot, page)));
  else {
    const { provs = [], options = [] } = plugins.find((x) => x.source === cur) ?? {};
    panel.push(pluginHead(cur, provs, slot.service, tr(slot.label), page));
    const rows = provs.flatMap((p) => p.items.map((it): [ItemProvider, ProviderItem] => [p, it]));
    const only = rows[0];
    const single = rows.length === 1 && !options.length && only && !only[1].group ? only : null;
    if (single) panel.push(...singleItem(slot, single[0], single[1], page));
    else if (rows.some(([, it]) => it.group)) panel.push(...groupedRows(slot, rows, page));
    else {
      // Choix offerts par ctx.offer seul (ex. les voix du système) : rien d'autre ne les montre.
      const kids = [...rows.map(([p, it]) => itemRow(slot, p, it, page)), ...options.map((o) => optionRow(slot, o, page))];
      if (!kids.length) {
        const app = appOf(cur)?.[1];
        // Plugin éteint, ou en erreur : dire pourquoi la liste est vide plutôt que « Rien pour l'instant ».
        kids.push(h("div", { class: "empty-line", text: app && (!app.enabled || app.status === "error" || app.status === "warn") ? tr(app.statusText) : t("noItems") }));
      }
      panel.push(h("div", { class: "scard" }, kids));
    }
  }
  return h("section", { class: "ssec", "data-tab": tr(slot.label), ...stepAttrs(slot) },
    secHead(tr(slot.label), tr(slot.description)),
    h("div", { class: "stabs", role: "tablist", "aria-label": tr(slot.label) }, tabs),
    // Clé par onglet : un autre plugin, un autre panneau (ses champs ne reprennent pas ceux du précédent).
    h("div", { class: "spanel", key: `panel:${cur}` }, panel));
}

/**
 * L'unique élément d'un onglet de plugin (ex. les mots d'activation) : pas de ligne qui répète l'onglet. En service :
 * l'onglet le dit déjà. Sinon (ou en panne) : sa ligne, pour l'activer. Puis son formulaire en place, et sa ligne de
 * détail (ex. le dernier réveil).
 */
function singleItem(slot: SettingsSlot, p: ItemProvider, it: ProviderItem, page: string): Child[] {
  const here = slot.value === valueOf(p, it);
  const form = inlineForm(p, it);
  const out: Child[] = [];
  if (!here || slot.state === "error" || !form) out.push(h("div", { class: "scard" }, itemRow(slot, p, it, page)));
  if (form) out.push(form);
  const detail = tr(it.detail);
  if (here && form && detail) out.push(h("p", { class: "ddesc idline", text: detail }));
  return out;
}

/**
 * Une carte par groupe (ex. des voix sous leur modèle), avec sa description et son état en tête.
 * Tous les éléments restent visibles, quel que soit le nombre de voix d'un modèle.
 */
function groupedRows(slot: SettingsSlot, rows: [ItemProvider, ProviderItem][], page: string): VNode[] {
  const groups: ItemGroup[] = [];
  for (const [, it] of rows) if (it.group && !groups.some((g) => g.id === it.group?.id)) groups.push(it.group);
  const here = rows.find(([p, it]) => slot.value === valueOf(p, it));
  const hereGroup = here?.[1].group?.id;
  const ungrouped = rows.filter(([, it]) => !it.group);
  const cards = groups.map((g) => {
    const isHere = g.id === hereGroup;
    return h("section", { class: "scard voice-group", key: g.id, "aria-label": tr(g.label) },
      h("header", { class: "voice-group-head" },
        h("div", { class: "rt" }, h("h4", { text: tr(g.label) }), h("div", { class: "rd", text: tr(g.detail) })),
        h("span", { class: `rs${isHere ? " use" : ""}`, text: isHere ? (slotStateText(slot) || t("loadedShort")) : t("idleShort") })),
      rows.filter(([, it]) => it.group?.id === g.id).map(([p, it]) => itemRow(slot, p, it, page)));
  });
  return [
    h("section", { class: "ssec" }, secHead(tr(slot.label), t("itemsNote")),
      ungrouped.length ? h("div", { class: "scard" }, ungrouped.map(([p, it]) => itemRow(slot, p, it, page))) : null,
      cards),
  ];
}

/** Page avec un slot « mode » : onglets de mode, puis le contenu de l'onglet choisi. */
function modeTabs(mode: SettingsSlot): VNode {
  const live = mode.value !== "@none";
  let cur = uiTab.get(mode.id);
  if (cur !== "@none" && cur !== "some") cur = live ? "some" : "@none";
  uiTab.set(mode.id, cur === "some" ? "some" : "@none");
  const tab = (id: string, label: string, on: boolean) => h("button", { type: "button", role: "tab", class: `stab big${id === cur ? " on" : ""}`, "aria-selected": String(id === cur), onclick: () => { uiTab.set(mode.id, id); render(); } }, label, on ? inUseBadge() : null);
  return h("div", { class: "stabs modes", role: "tablist", "aria-label": t("mode") },
    tab("@none", tr(mode.none), !live), tab("some", tr(mode.label), live),
    h("span", { class: "tabnote", text: tr(mode.description) }));
}

/** Le contenu d'une page à slots (ajouté à `nodes`). restSettings : ses autres réglages. embedded : dans la page d'un élément. */
export function slotPage(page: string, nodes: Child[], restSettings: SettingInfo[], embedded = false): void {
  const mode = modeSlotOf(page);
  const chain = chainOf(slotsOn(page).filter((x) => x !== mode));
  chainNow = new Map((chain ?? []).map((x, i) => [x.id, i + 1]));
  const others = chain ?? slotsOn(page).filter((x) => x !== mode);
  // Les réglages communs (ex. Général / Ton) précèdent les onglets des moteurs.
  if (restSettings.length) nodes.push(...settingsBlocks(restSettings));
  // Fournisseurs de la page qui n'offrent rien (ni slot, ni application) : le contenu propre de la rubrique (ex. les
  // centres d'intérêt de la Veille). En premier : c'est ce qu'on vient régler.
  for (const p of S.items.providers) {
    if (pageOf(p.section) !== page || offersOf(p).length || p.id.startsWith("apps-")) continue;
    const c = p.layout === "grid" ? avatarGrid(p) : providerCard(p);
    if (c) nodes.push(c);
  }
  const slotNode = (s: SettingsSlot): VNode => (s.display === "tabs" ? slotTabs(s, page) : slotList(s, page));
  let listed: string[] = [];
  if (mode) {
    nodes.push(modeTabs(mode));
    if (uiTab.get(mode.id) === "some") {
      if (mode.value === "@none") nodes.push(h("div", { class: "sinfo", text: t("modeOff") }));
      nodes.push(slotList(mode, page, { withNone: false, title: `${t("engineOf")} ${tr(mode.label)}`, sub: t("engineNote") }));
      listed = [mode.service];
    } else {
      if (mode.value !== "@none") nodes.push(h("div", { class: "sinfo", text: t("modeOffLocal") }));
      nodes.push(...others.map(slotNode));
      listed = others.filter((s) => s.display !== "tabs").map((s) => s.service);
    }
  } else {
    nodes.push(...others.map(slotNode));
    listed = others.filter((s) => s.display !== "tabs").map((s) => s.service);
  }
  if (listed.length && !embedded) nodes.push(pluginCards(listed, page, t("pluginsOf")));
}

/** Ce qui est en service, pour le menu de gauche. */
export function navSummary(page: string): string {
  const mode = modeSlotOf(page);
  if (mode) {
    if (mode.value !== "@none") return `${tr(mode.label)} · ${slotLabelOf(mode)}`;
    const main = slotsOn(page).find((x) => x !== mode && !x.none) ?? slotsOn(page).find((x) => x !== mode);
    return main ? `${tr(mode.none)} · ${slotLabelOf(main)}` : tr(mode.none);
  }
  const s = slotsOn(page)[0];
  return s ? slotLabelOf(s) : "";
}
