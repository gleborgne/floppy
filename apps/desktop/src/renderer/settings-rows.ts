// Fenêtre des réglages : les briques des pages. Une ligne par élément (nom, détail, état, interrupteur, action, accès à
// sa page), les listes et cartes d'un fournisseur, la grille des avatars, et les onglets génériques d'une page.
import { h, icon } from "./dom.ts";
import type { Child, Ev } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { offersOf } from "./slot-sources.ts";
import { openCatalogue, openEditor } from "./settings-dialogs.ts";
import type { CatalogRole } from "./settings-dialogs.ts";
import {
  S, activate, appProviders, canFill, filledBy, matches, openDetail, pageOf, provBusy, quickOp, itemOp, playAudio,
  render, setSlot, slotNote, slotStateText, slotsFor, t, toast, tr, valueOf,
} from "./settings-state.ts";

// ------------------------------------------------------------------ onglets génériques
/** Données d'un bloc (attribut data-… de son élément virtuel). */
const dataOf = (n: Child, k: string): string | undefined => (n ? (n.props as Record<string, string | undefined>)[`data-${k}`] : undefined);
const tabSel = new Map<string, string>();   // page -> onglet choisi
let tabIn = false;          // ce dessin suit un changement d'onglet : l'onglet entre en fondu
/** settings.js le dit avant chaque dessin. */
export function tabsEnter(on: boolean): void { tabIn = on; }

/**
 * Onglets génériques : les blocs qui portent un nom (data-tab) deviennent des onglets, un seul visible à la fois ;
 * les blocs sans nom restent au-dessus (tête, modes, messages), ceux marqués data-place="end" en dessous (Modifier,
 * Supprimer). Un seul nom : pas d'onglets, tout reste affiché. key : garde l'onglet choisi par page.
 */
export function tabify(key: string, nodes: Child[]): VNode[] {
  const list = nodes.filter((n): n is VNode => !!n);
  // Un bloc léger (1 ou 2 réglages, ex. le Ton sous Voix) ne vaut pas un onglet : il reste affiché sur la page.
  const named = list.filter((n) => dataOf(n, "tab") && !dataOf(n, "light"));
  const labels = [...new Set(named.map((n) => dataOf(n, "tab") ?? ""))];
  if (labels.length < 2) return list;
  let cur = tabSel.get(key) ?? "";
  if (!labels.includes(cur)) cur = labels[0] ?? "";
  const pick = (l: string) => { tabSel.set(key, l); S.navAnim = "tab"; render(); requestAnimationFrame(() => document.querySelector<HTMLElement>(".ptab.on")?.focus()); };
  // Un onglet « étape » (slot d'une chaîne, data-step) devient une case : n° et rôle, puis ce qui est en service.
  // Les étapes d'abord, dans leur ordre, reliées par des flèches ; les autres onglets (ex. Plugins) après.
  const stepOf = (l: string) => named.find((n) => dataOf(n, "tab") === l && dataOf(n, "step"));
  const steps = labels.filter(stepOf).sort((a, b) => Number(dataOf(stepOf(a), "step")) - Number(dataOf(stepOf(b), "step")));
  if (steps.length) labels.splice(0, labels.length, ...steps, ...labels.filter((l) => !stepOf(l)));
  const ids = labels.map((l) => `tab-${key}-${l}`.replace(/[^\w-]+/g, "_"));
  const tabBtn = (l: string, i: number) => {
    const node = stepOf(l);
    const kids = node ? [h("span", { class: "k", text: `${dataOf(node, "step")} · ${l}` }), h("span", { class: "v", text: dataOf(node, "step-value") ?? "" })] : [l];
    return h("button", {
      type: "button", role: "tab", id: ids[i], key: `t:${l}`, class: `ptab${node ? " pstep" : ""}${l === cur ? " on" : ""}`, "aria-selected": String(l === cur), tabindex: l === cur ? "0" : "-1",
      onclick: () => pick(l),
      onkeydown: (e: Ev<KeyboardEvent>) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) { e.preventDefault(); pick(labels[(i + d + labels.length) % labels.length] ?? ""); }
      },
    }, ...kids);
  };
  const bar = h("div", { class: `ptabs${steps.length ? " chain" : ""}`, role: "tablist", ...(steps.length ? { "aria-label": t("steps") } : {}) },
    labels.flatMap((l, i) => [
      i > 0 && i < steps.length ? h("span", { class: "parrow", "aria-hidden": "true", key: `a:${l}` }, icon("arrow-right")) : null,
      steps.length && i === steps.length ? h("span", { class: "pgap", "aria-hidden": "true", key: "gap" }) : null,
      tabBtn(l, i),
    ].filter(Boolean)));
  // Clé par onglet : changer d'onglet pose un nouveau panneau (il entre en fondu), un nouveau dessin du même ne bouge pas.
  const panel = h("div", { class: `tabpanel${tabIn ? " tabin" : ""}`, key: `panel:${cur}`, role: "tabpanel", "aria-labelledby": ids[labels.indexOf(cur)] }, named.filter((n) => dataOf(n, "tab") === cur));
  const top = list.filter((n) => !dataOf(n, "tab") && dataOf(n, "place") !== "end");
  const light = list.filter((n) => dataOf(n, "tab") && dataOf(n, "light"));
  const end = list.filter((n) => dataOf(n, "place") === "end");
  return [...top, ...light, bar, panel, ...end];
}

// ------------------------------------------------------------------ petites briques
export function inUseBadge(): VNode { return h("span", { class: "inuse" }, h("i", { "aria-hidden": "true" }), t("inUseShort")); }

export function secHead(title: string, sub?: string, extra?: Child): VNode {
  return h("h3", { class: "shead" }, h("span", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, extra ?? null);
}

/** Bouton rond « lecture » au début d'une ligne : l'action de l'élément qui rend un son (actions[].play). */
function playLead(p: ItemProvider, it: ProviderItem): VNode | null {
  const a = (it.actions ?? []).find((x) => x.play);
  if (!a) return null;
  return h("button", {
    type: "button", class: "vplay", "aria-label": `${tr(a.label)} : ${tr(it.label)}`,
    onclick: async (e: Ev<MouseEvent>) => {
      e.stopPropagation();
      const r = await itemOp({ op: "action", provider: p.id, id: it.id, action: a.id });
      if (r.ok && r.audio) playAudio(r.audio); else toast(r.text || t("refused"), true);
    },
  }, icon("play"));
}

/** « + Ajouter … » d'un fournisseur : un bouton par type quand il en a plusieurs (ex. « Nouvelle voix », « Modèle local »). */
export function addButtons(p: ItemProvider): VNode[] {
  if (!p.can.add || !p.kinds.length) return [];
  // Un seul type, ou beaucoup (ex. les connecteurs) : un bouton, qui fait choisir le type.
  if (p.kinds.length === 1 || p.kinds.length > 3) return [h("button", { type: "button", class: "btn small", key: `add:${p.id}`, text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) })];
  return p.kinds.map((k) => h("button", { type: "button", class: "btn small", key: `add:${p.id}/${k.id}`, text: `+ ${tr(k.label)}`, onclick: () => openEditor({ mode: "add", kinds: [{ provider: p, kind: k }] }) }));
}

export function switchBtn(p: ItemProvider, it: ProviderItem, offering?: boolean): VNode {
  const canToggle = p.can.enable && it.toggleable !== false;
  const on = offering ? t("available") : t("on");
  return h("button", {
    type: "button", class: "sw", role: "switch", "aria-checked": String(!!it.enabled), disabled: !canToggle,
    title: it.enabled ? (offering ? t("availTip") : t("onTip")) : (offering ? t("hiddenTip") : t("offTip")),
    "aria-label": `${tr(it.label)} : ${it.enabled ? on : (offering ? t("hidden") : t("off"))}`,
    onclick: (e: Ev<MouseEvent>) => { e.stopPropagation(); quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }); },
  }, h("i"));
}

export function shortStatus(p: ItemProvider, it: ProviderItem): string {
  if (!it.enabled) return offersOf(p).length ? t("hidden") : t("off");
  const fills = filledBy(p, it);
  if (fills.length) {
    const st = fills.map(slotStateText).find(Boolean);
    return `${fills.map((x) => tr(x.label)).join(" · ")}${st ? ` · ${st}` : ""}`;
  }
  return tr(it.statusText) || (it.active ? t("active") : "");
}

/** Logo d'un élément (adresse data:image/… ; l'app a déjà lu les icônes des programmes), sinon null. */
export const logoOf = (it: ProviderItem): string | null => (typeof it.logo === "string" && it.logo.startsWith("data:image/") ? it.logo : null);
/** Case du logo au début d'une ligne : le logo, ou l'initiale si un voisin a un logo (les noms restent alignés). */
export function logoTile(it: ProviderItem): VNode {
  const src = logoOf(it);
  return src
    ? h("span", { class: "lg", "aria-hidden": "true" }, h("img", { src, alt: "" }))
    : h("span", { class: "lg none", "aria-hidden": "true", text: tr(it.label).slice(0, 1).toUpperCase() });
}

// ------------------------------------------------------------------ une ligne
/**
 * Une ligne : nom, détail, état, [interrupteur], [action], [Réglages].
 * L'interrupteur remplace l'ancien bouton « Activer » : allumé = en service pour ce rôle ; en allumer un autre éteint
 * le précédent (un seul à la fois). L'éteindre : seulement si le rôle accepte « aucun » (onOff). actEl : un autre
 * interrupteur à la même place (Actif / Inactif d'un élément sans rôle). rowLink : toute la ligne ouvre la page de
 * l'élément (flèche « › » au lieu du bouton Réglages).
 */
/** Ce qu'une ligne montre et permet (voir row). */
export interface RowArgs {
  name: string; detail?: string; state?: string; stateCls?: string; cloud?: boolean; here?: boolean; canAct?: boolean;
  onAct?: (() => unknown) | null; onOff?: (() => unknown) | null; actEl?: VNode; onSettings?: (() => unknown) | null; settingsOpen?: boolean;
  rowLink?: boolean; lead?: Child; extraBtn?: VNode; selected?: boolean; onPick?: (() => unknown) | null; key?: string;
}
export function row({ name, detail, state, stateCls, cloud, here, canAct, onAct, onOff, actEl, onSettings, settingsOpen, rowLink, lead, extraBtn, selected, onPick, key }: RowArgs): VNode {
  if (rowLink && onSettings) onPick = onSettings;
  const acts: Child[] = [];
  if (actEl) acts.push(actEl);
  else if (onAct || here) {
    const can = here ? !!onOff : !!canAct;
    acts.push(h("button", {
      // En service sans « aucun » possible : allumé (pas grisé), le clic ne fait rien, la bulle dit comment changer.
      type: "button", class: "sw", role: "switch", "aria-checked": String(!!here), disabled: (!here && !can) || !!S.pendingSlot,
      "aria-disabled": here && !can ? "true" : null,
      "aria-label": `${name} : ${here ? t("inUseShort") : t("activate")}`,
      title: here ? (onOff ? t("turnOffTip") : t("inUseTip")) : t("activateTip"),
      onclick: (e: Ev<MouseEvent>) => { e.stopPropagation(); if (here) { if (onOff) onOff(); } else onAct?.(); },
    }, h("i")));
  } else acts.push(h("span", { class: "act" }));
  if (extraBtn) acts.push(extraBtn);
  if (onSettings && rowLink) acts.push(h("span", { class: "chev", "aria-hidden": "true" }, icon("chevron-right")));
  else if (onSettings) acts.push(h("button", { type: "button", class: `btn small${settingsOpen ? " on" : ""}`, "aria-expanded": settingsOpen === undefined ? null : String(settingsOpen), text: t("settingsBtn"), onclick: (e) => { e.stopPropagation(); onSettings(); } }));
  else if (!extraBtn) acts.push(h("span", { class: "setph" }));
  const st = here && !state ? t("inUseShort") : state;
  return h("div", {
    class: `srow${here ? " here" : ""}${selected ? " picked" : ""}${onPick ? " pick" : ""}`,
    ...(key ? { key } : {}),
    ...(onPick ? {
      tabindex: "0",
      "aria-label": rowLink ? `${name} : ${t("openDetail")}` : null,
      onclick: () => onPick(),
      // Entrée ou espace sur la ligne elle-même (pas sur un de ses boutons).
      onkeydown: (e: Ev<KeyboardEvent>) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(); } },
    } : {}),
  },
  lead ?? null,
  h("div", { class: "rt" }, h("div", { class: "rn" }, h("strong", { text: name }), cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null), detail ? h("div", { class: "rd", text: detail }) : null),
  h("span", { class: `rs ${stateCls || (here ? "use" : "")}`, text: st ?? "" }),
  h("div", { class: "racts" }, acts));
}

/** La ligne d'un élément pour un slot (Activer, état, page de l'élément). */
export function itemRow(slot: SettingsSlot, p: ItemProvider, it: ProviderItem, page: string): VNode {
  const v = valueOf(p, it);
  const here = slot.value === v;
  const st = here ? (slotStateText(slot) || tr(it.statusText)) : !it.enabled ? t("hidden") : tr(it.statusText);
  const cls = here && slot.state === "error" ? "err" : it.status === "warn" ? "warn" : it.status === "error" ? "err" : "";
  const editable = (p.can.update && it.editable !== false) || (p.can.enable && it.toggleable !== false) || (p.can.remove && it.removable !== false);
  return row({
    key: `${p.id}/${it.id}`,
    name: tr(it.label), detail: [tr(it.detail), slotNote(slot, v)].filter(Boolean).join(" · "), state: S.pendingSlot === slot.id && !here ? "" : st, stateCls: cls, cloud: it.cloud, here,
    canAct: canFill(slot, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => activate(slot, v, page),
    onOff: slot.none ? () => activate(slot, "@none", page) : null,
    onSettings: editable ? () => openDetail(p, it) : null, rowLink: true,
    lead: playLead(p, it),
  });
}

/** Un choix offert par ctx.offer seul (ex. une voix du système) : rien d'autre ne le montre. */
export function optionRow(slot: SettingsSlot, o: SettingOption, page: string): VNode {
  const here = slot.value === o.value;
  return row({
    key: `o:${o.value}`,
    name: tr(o.label), detail: tr(o.note), state: here ? slotStateText(slot) : "", stateCls: here && slot.state === "error" ? "err" : "", cloud: o.cloud, here,
    canAct: true, onAct: () => activate(slot, o.value, page),
    onOff: slot.none ? () => activate(slot, "@none", page) : null,
  });
}

export function noneRow(slot: SettingsSlot, page: string): VNode {
  return row({ key: "@none", name: tr(slot.none), here: slot.value === "@none", canAct: true, onAct: () => activate(slot, "@none", page) });
}

/** La ligne d'un élément dans une liste de rubrique (connecteur, centre d'intérêt, tâche…). */
function entryRow(p: ItemProvider, it: ProviderItem, logos = false): VNode {
  const offering = offersOf(p).length > 0;
  const fills = filledBy(p, it);
  // Un seul rôle possible : son interrupteur est dans la ligne. Plusieurs (ex. cerveau ET délégation) : dans Réglages.
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  const one = roles.length === 1 ? roles[0] : null;
  const [first] = String(tr(it.detail) ?? "").split("\n");
  const err = it.status === "error" || fills.some((x) => x.state === "error");
  // Élément sans rôle (connecteur, centre d'intérêt, tâche) : interrupteur Actif, et sa 1re action en bouton.
  const plain = !offering && p.can.enable && it.toggleable !== false;
  const firstAct = !offering && it.enabled ? (it.actions ?? [])[0] : undefined;
  return h("div", { class: `rwrap${it.enabled ? "" : " off"}`, key: `${p.id}/${it.id}` }, row({
    name: tr(it.label), detail: first, state: shortStatus(p, it), stateCls: err ? "err" : it.status === "warn" ? "warn" : "", cloud: it.cloud,
    here: one ? one.value === valueOf(p, it) : fills.length > 0,
    ...(one && it.enabled ? { canAct: canFill(one, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => setSlot(one, valueOf(p, it)), onOff: one.none ? () => setSlot(one, "@none") : null } : {}),
    ...(plain ? { actEl: switchBtn(p, it) } : {}),
    ...(firstAct ? { extraBtn: h("button", { type: "button", class: "btn small", text: tr(firstAct.label), onclick: (e: Ev<MouseEvent>) => { e.stopPropagation(); quickOp({ op: "action", provider: p.id, id: it.id, action: firstAct.id }); } }) } : {}),
    onSettings: () => openDetail(p, it), rowLink: true,
    ...(logos ? { lead: logoTile(it) } : {}),
  }));
}

/** Lignes d'éléments : [fournisseur, élément, groupe] ; un titre par groupe s'il y en a plusieurs. */
/** [fournisseur, élément, groupe] */
export type RowEntry = [ItemProvider, ProviderItem, string];
export function rowList(entries: RowEntry[]): VNode {
  const logos = entries.some(([, it]) => logoOf(it));
  const groups = new Set(entries.map((e) => e[2] || "")).size > 1;
  const kids: VNode[] = [];
  let last: string | null = null;
  for (const [p, it, group] of entries) {
    if (groups && group !== last) { kids.push(h("div", { class: "sgrp", key: `g:${group}`, text: group || "" })); last = group; }
    kids.push(entryRow(p, it, logos));
  }
  return h("div", { class: "scard" }, kids);
}

// ------------------------------------------------------------------ cartes de fournisseurs
export function visibleItems(p: ItemProvider): ProviderItem[] {
  return p.items.filter((it) => matches(it.label, it.detail, ...(it.tags ?? []), it.id, ...(it.children ?? []).map((c) => c.label), p.label));
}

export function providerCard(p: ItemProvider): VNode | null {
  const list = visibleItems(p);
  if (S.query && !list.length) return null;
  // Un fournisseur dont aucun slot ne sert en ce moment (ex. modèles locaux en mode Live) : grisé, avec la raison.
  const sleeping = slotsFor(p).length > 0 && !provBusy(p) && slotsFor(p).every((x) => x.state === "idle" || x.state === "none");
  // Le bouton du haut de la page ajoute un plugin quand la rubrique a des plugins : l'ajout d'un élément va alors dans sa carte.
  const ownAdd = p.can.add && p.kinds.length && appProviders().some((a) => a.section === pageOf(p.section));
  return h("section", { class: `prov${sleeping ? " sleeping" : ""}`, "aria-label": tr(p.label), "data-tab": tr(p.label), key: `prov:${p.id}` },
    h("div", { class: "prov-head" }, h("strong", { text: tr(p.label) }), p.badge ? h("span", { class: "badge", text: tr(p.badge) }) : null,
      h("span", { class: "idetail desc", text: tr(p.description) }),
      ownAdd ? h("button", { type: "button", class: "btn small pri padd", text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) }) : null),
    p.error ? h("div", { class: "ierr", role: "alert", text: `${t("provError")} : ${tr(p.error)}` }) : null,
    sleeping && slotsFor(p).some((x) => x.state === "idle") ? h("div", { class: "sleep-note", text: t("provIdle") }) : null,
    list.length ? rowList(list.map((it) => [p, it, ""])) : h("div", { class: "empty-line", text: t("noItems") }));
}

export function avatarGrid(p: ItemProvider): VNode | null {
  const list = visibleItems(p);
  if (S.query && !list.length) return null;
  return h("div", { class: "avgrid", role: "list" }, list.map((it) => {
    const name = tr(it.label);
    const canToggle = p.can.enable && it.toggleable !== false;
    return h("div", { class: `av${it.active ? " on" : ""}${it.enabled ? "" : " off"}`, role: "listitem", key: it.id },
      // Aperçu de l'avatar (image fixe) ; sans aperçu, son initiale.
      typeof it.preview === "string" && it.preview.startsWith("data:image/")
        ? h("div", { class: "pv img", "aria-hidden": "true" }, h("img", { src: it.preview, alt: "" }))
        : h("div", { class: "pv", "aria-hidden": "true", text: name.slice(0, 1).toUpperCase() }),
      h("div", { class: "bd" },
        h("div", { class: "t" }, h("strong", { text: name }), it.active ? h("span", { class: "chip", text: it.statusText ? tr(it.statusText) : t("active") }) : null),
        h("span", { class: "d", text: tr(it.detail) }),
        h("div", { class: "tags" }, (it.tags ?? []).map((g) => h("span", { class: "chip tag", text: tr(g) }))),
        h("div", { class: "ctl" },
          (it.actions ?? []).map((a) => h("button", { type: "button", class: "btn small", text: tr(a.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: a.id }) })),
          h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(!!it.enabled), disabled: !canToggle, title: it.enabled ? t("onTip") : t("offTip"),
            "aria-label": `${name} : ${it.enabled ? t("on") : t("off")}`, onclick: () => quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }) }, h("i"), h("span", { text: it.enabled ? t("on") : t("off") })))));
  }));
}

/** « + Ajouter un plugin » pour un rôle (le catalogue filtré). */
export const addPluginBtn = (page: string, role?: CatalogRole, cls = "btn small"): VNode => h("button", { type: "button", class: cls, text: `+ ${t("addPlugin")}`, onclick: () => openCatalogue(page, role) });
