// Fenêtre des réglages : les contrôles des réglages déclarés par les plugins (choix, interrupteur, curseur, texte),
// groupés en blocs.
import { h } from "./dom.js";
import { isLight } from "./tab-rules.js";
import { S, api, render, setValue, t, tr } from "./settings-state.js";

const labelOf = (info) => tr(info.label);

function enumControl(info, apply) {
  const opts = info.options ?? [];
  if (opts.length > 4) {
    return h("select", { "aria-label": labelOf(info), value: String(info.value), onchange: (e) => apply(e.currentTarget.value) },
      opts.map((o) => h("option", { value: o.value, text: tr(o.label) })));
  }
  return h("div", { class: "seg", role: "radiogroup", "aria-label": labelOf(info) },
    opts.map((o) => h("button", { type: "button", role: "radio", "aria-checked": String(String(o.value) === String(info.value)), text: tr(o.label), onclick: () => apply(o.value) })));
}

function boolControl(info, apply) {
  const on = info.value === true;
  return h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(on), "aria-label": labelOf(info), onclick: () => apply(!on) }, h("i"));
}

/** Position d'un curseur pendant qu'on le fait glisser (réglage -> valeur), avant qu'il soit relâché et enregistré. */
const sliding = new Map();

function numControl(info, apply) {
  const min = info.min ?? 0, max = info.max ?? 100;
  const cur = sliding.get(info.key) ?? String(info.value);
  return h("div", { class: "num" },
    // defaultValue : le curseur suit le réglage sans être repris pendant qu'on le fait glisser.
    h("input", {
      type: "range", "aria-label": labelOf(info), min, max, step: max - min <= 5 ? "0.1" : "1", defaultValue: String(info.value),
      style: { "--fill": `${((+cur - min) / (max - min || 1)) * 100}%` },
      oninput: (e) => { sliding.set(info.key, e.currentTarget.value); render(); },
      onchange: (e) => { sliding.delete(info.key); apply(Number(e.currentTarget.value)); },
    }),
    h("output", { text: cur }));
}

function textControl(info, apply) {
  let input = null;
  const put = (v) => { if (input) input.value = String(v); apply(v); };
  // defaultValue : le champ montre le réglage sans écraser ce qu'on est en train d'y taper.
  const field = h("input", {
    type: "text", "aria-label": labelOf(info), maxlength: info.maxLength, defaultValue: String(info.value ?? ""),
    ref: (el) => { input = el; },
    onkeydown: (e) => { if (e.key === "Enter") apply(e.currentTarget.value); },
  });
  const ok = h("button", { type: "button", text: t("apply"), onclick: () => apply(input?.value ?? "") });
  // Un dossier (répertoire de travail, modèles) : « Parcourir… » ouvre le sélecteur de dossiers du système.
  const browse = info.folder && api?.pickPath ? h("button", {
    type: "button", class: "sec", text: t("pick"),
    onclick: async () => { const p = await api.pickPath({ directory: true }); if (p) put(p); },
  }) : null;
  return h("div", {}, h("div", { class: "txt" }, field, browse, ok),
    info.presets?.length ? h("div", { class: "chips" }, info.presets.map((p) =>
      h("button", { type: "button", class: String(p.value) === String(info.value) ? "on" : "", title: String(p.value), text: tr(p.label), onclick: () => put(p.value) }))) : null);
}

export function settingRow(info) {
  const apply = (v) => setValue(info.key, v);
  const ctl = { enum: enumControl, boolean: boolControl, number: numControl, text: textControl }[info.type]?.(info, apply);
  const label = h("div", { class: "label", text: labelOf(info) },
    info.risk === "ask" ? h("span", { class: "tag", text: t("askVoice") }) : null,
    info.risk === "cli" ? h("span", { class: "tag cli", text: t("cliOnly") }) : null);
  return h("div", { class: info.type === "text" ? "row wide" : "row", key: info.key }, h("div", {}, label, h("div", { class: "desc", text: tr(info.description) })), ctl);
}

/** Réglages groupés par leur groupe : un bloc chacun (un onglet de la page s'il y en a plusieurs). */
export function settingsBlocks(list) {
  const groups = new Map();
  for (const s of list) {
    const g = tr(s.group) || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  return [...groups].map(([g, l]) => h("div", { class: "sgroup", "data-tab": g || t("settingsTab"), ...(isLight(l) ? { "data-light": "1" } : {}) },
    g ? h("h3", { text: g }) : null, h("div", { class: "card" }, l.map(settingRow))));
}

/** Les réglages qui appartiennent à un élément (it.settings). */
export const ownSettings = (it) => (it.settings ?? []).map((key) => S.settings.list.find((x) => x.key === key)).filter(Boolean);
