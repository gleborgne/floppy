// Fenêtre des réglages : la page d'un élément. Fil d'Ariane (Retour, Échap), titre, sa ligne avec ses commandes, puis
// son détail en blocs : suite de la description, Activer, formulaire en place, actions, réglages propres, sous-éléments
// à cocher, rubrique rattachée (ex. la Veille sous sa tâche). Les éléments de cette page ouvrent à leur tour leur page :
// Tâches › Veille du jour › IA locale.
import { h, icon, nextId } from "./dom.js";
import { offersOf } from "./slot-sources.js";
import { ownSettings, settingRow } from "./settings-controls.js";
import { inlineForm } from "./settings-form.js";
import { pageNodes } from "./settings-pages.js";
import { logoOf, logoTile, row, shortStatus, switchBtn, tabify } from "./settings-rows.js";
import {
  S, canFill, closeDetail, filledBy, quickOp, render, secLabel, setSlot, slotStateText, slotsFor, t, tr, valueOf,
} from "./settings-state.js";

/** « Supprimer » d'un élément, en deux clics (le second confirme, 5 s pour le faire). null : pas supprimable. */
function removeBtn(p, it) {
  if (!p.can.remove || it.removable === false) return null;
  const k = `${p.id}/${it.id}`;
  const sure = S.removing === k;
  return h("button", {
    type: "button", class: "btn small danger", text: sure ? t("removeSure") : t("remove"),
    onclick: async () => {
      if (!sure) { S.removing = k; render(); setTimeout(() => { if (S.removing === k) { S.removing = ""; render(); } }, 5000); return; }
      S.removing = "";
      await quickOp({ op: "remove", provider: p.id, id: it.id });
    },
  });
}

/** Boutons « Activer » d'un élément : un par slot qu'il peut remplir (ou l'état « En service » et « Retirer »). */
function activateBar(p, it) {
  if (!it.enabled) return h("div", { class: "dacts activate" }, h("p", { class: "desc", text: t("makeAvail") }));
  const slots = slotsFor(p);
  const kids = [];
  for (const slot of slots) {
    const here = slot.value === valueOf(p, it);
    const busy = S.pendingSlot === slot.id;
    if (here) {
      const st = slotStateText(slot);
      kids.push(h("span", { class: `chip use${slot.state === "error" ? " err" : ""}`, key: `use:${slot.id}` }, icon("check"), `${tr(slot.label)}${st ? ` · ${st}` : ""}`));
      if (slot.none) kids.push(h("button", { type: "button", class: "btn", key: `off:${slot.id}`, disabled: busy, text: t("remove1"), onclick: () => setSlot(slot, "@none") }));
    } else if (canFill(slot, p, it)) {
      const text = busy ? t("loading") : slots.length > 1 ? `${t("activateAs")} ${tr(slot.label).toLowerCase()}` : t("activate");
      kids.push(h("button", { type: "button", class: "btn pri", key: `on:${slot.id}`, disabled: busy || !!S.pendingSlot, text, title: tr(slot.description), onclick: () => setSlot(slot, valueOf(p, it)) }));
    }
  }
  return h("div", { class: "dacts activate" }, kids);
}

/** Le détail d'un élément, en blocs : sans nom (en haut), avec un nom d'onglet (data-tab), ou en bas (data-place="end"). */
function rowBody(p, it, more, firstShown) {
  const box = [];
  const offering = offersOf(p).length > 0;
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  if (offering && roles.length > 1) box.push(activateBar(p, it));
  if (more.length) box.push(h("p", { class: "ddesc", text: more.join("\n") }));
  const form = inlineForm(p, it);
  if (form) box.push(form);
  const acts = (it.actions ?? []).slice(firstShown ? 1 : 0);
  if (acts.length && it.enabled) box.push(h("div", { class: "dacts" }, acts.map((a) => h("button", { type: "button", class: "btn small", key: a.id, text: tr(a.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: a.id }) }))));
  const own = ownSettings(it);
  if (own.length) box.push(h("div", { class: "card", "data-tab": t("settingsTab") }, own.map(settingRow)));
  if (it.children?.length) {
    const on = it.children.filter((c) => c.enabled).length;
    const lab = tr(it.childrenLabel ?? p.childrenLabel) || t("childrenDef");
    box.push(h("div", { class: "dsec", "data-tab": lab }, h("h4", { text: `${lab} · ${on}/${it.children.length}` }),
      h("ul", { class: "dtools" }, it.children.map((c) => {
        const id = nextId();
        return h("li", { key: c.id },
          h("input", { type: "checkbox", id, checked: c.enabled, disabled: !p.can.child, onchange: (e) => quickOp({ op: "child", provider: p.id, id: it.id, child: c.id, on: e.currentTarget.checked }) }),
          h("label", { for: id }, h("code", { text: tr(c.label) }), c.detail ? h("small", { text: tr(c.detail) }) : null),
          c.tag ? h("span", { class: `chip ${c.tone === "warn" || c.tone === "danger" ? "warn" : "tag"}`, text: tr(c.tag) }) : null);
      }))));
  }
  // Rubrique rattachée (ex. la Veille sous « Veille du jour ») : son contenu ici, sans ses cartes de plugins.
  if (it.section) {
    const sub = [];
    pageNodes(it.section, sub, { embedded: true });
    box.push(...sub.filter(Boolean));
  }
  // Masquer un élément à rôle (modèle, voix) : il reste dans la liste, Floppy ne le voit plus.
  if (offering && p.can.enable && it.toggleable !== false) {
    box.push(h("div", { class: "dfoot", "data-place": "end" },
      h("button", { type: "button", class: "btn small", text: it.enabled ? t("hideIt") : t("showIt"), onclick: () => quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }) })));
  }
  if (!box.length) box.push(h("p", { class: "ddesc", text: t("noMore") }));
  return box;
}

/** La page de l'élément le plus profond de la pile, ou null (élément disparu : on remonte au dernier qui existe). */
export function detailPage() {
  const chain = [];
  for (const d of S.detailStack) {
    const p = S.items.providers.find((x) => x.id === d.pid);
    const it = p?.items.find((x) => x.id === d.iid);
    if (!p || !it) break;
    chain.push([p, it]);
  }
  if (chain.length !== S.detailStack.length) S.detailStack = S.detailStack.slice(0, chain.length);
  if (!chain.length) return null;
  const [p, it] = chain[chain.length - 1];
  const crumbs = h("nav", { class: "crumbs", "aria-label": t("crumbs") },
    h("button", { type: "button", class: "btn small back", onclick: () => closeDetail(1) }, icon("arrow-left"), t("back")),
    h("button", { type: "button", class: "crumb", text: secLabel(S.section), onclick: () => closeDetail(Infinity) }),
    chain.slice(0, -1).flatMap(([, x], i) => [h("span", { class: "sep", "aria-hidden": "true" }, icon("chevron-right")), h("button", { type: "button", class: "crumb", text: tr(x.label), onclick: () => closeDetail(chain.length - 1 - i) })]),
    h("span", { class: "sep", "aria-hidden": "true" }, icon("chevron-right")), h("span", { class: "crumb cur", "aria-current": "page", text: tr(it.label) }));
  const offering = offersOf(p).length > 0;
  const fills = filledBy(p, it);
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  const one = roles.length === 1 ? roles[0] : null;
  const [first, ...more] = String(tr(it.detail) ?? "").split("\n");
  const firstAct = !offering && it.enabled ? (it.actions ?? [])[0] : undefined;
  // La même ligne que dans la liste, sans « Réglages » : l'élément tel qu'on l'a quitté, avec ses commandes.
  const head = row({
    name: tr(it.label), detail: first, state: shortStatus(p, it), stateCls: it.status === "error" || fills.some((x) => x.state === "error") ? "err" : it.status === "warn" ? "warn" : "", cloud: it.cloud,
    here: one ? one.value === valueOf(p, it) : fills.length > 0,
    ...(one && it.enabled ? { canAct: canFill(one, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => setSlot(one, valueOf(p, it)), onOff: one.none ? () => setSlot(one, "@none") : null } : {}),
    ...(!offering && p.can.enable && it.toggleable !== false ? { actEl: switchBtn(p, it) } : {}),
    ...(firstAct ? { extraBtn: h("button", { type: "button", class: "btn small", text: tr(firstAct.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: firstAct.id }) }) } : {}),
    ...(logoOf(it) ? { lead: logoTile(it) } : {}),
  });
  return h("div", { class: "dpage" }, crumbs,
    // « Supprimer » en haut, à côté du nom : en bas, il se perdait sous les longs formulaires (ex. une voix).
    h("div", { class: "page-head" }, h("div", {}, h("h2", { text: tr(it.label) }), h("p", { text: tr(p.label) })), removeBtn(p, it)),
    h("div", { class: "scard dhead" }, head),
    h("div", { class: "dbody" }, tabify(`detail:${S.detailStack.map((d) => `${d.pid}/${d.iid}`).join(">")}`, rowBody(p, it, more, !!firstAct))));
}
