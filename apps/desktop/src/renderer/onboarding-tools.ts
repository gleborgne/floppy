// Fenêtre « Bienvenue » : l'écran « outils » : les connecteurs ajoutés à Floppy, avec un interrupteur (même opération que les Réglages).
import { h, icon, switchBtn } from "./onboarding-dom.ts";
import { api, S, setTool, t, txt } from "./onboarding-state.ts";
import { pageHead } from "./onboarding-list.ts";

export function toolsPage(): HTMLElement[] {
  const nodes: HTMLElement[] = [pageHead(t("tools.title"), t("tools.lead"))];
  const items = S.extras?.tools.items ?? [];
  if (!items.length) {
    nodes.push(h("p", { class: "hint", text: t("toolsNone") }));
    nodes.push(h("div", {}, h("button", { type: "button", class: "btn", text: t("openSettings"), k: "settings", onclick: () => api?.openSettings() })));
  } else {
    nodes.push(h("div", { class: "card lines" }, items.map((it) => h("div", { class: "line way" }, h("span", { class: "lic" }, icon("tools", 22)),
      h("div", { class: "line-text" }, h("span", { class: "t", text: txt(it.label) }), h("span", { class: "s", text: txt(it.detail) })),
      switchBtn({ on: it.enabled, label: `${txt(it.label)} : ${t(it.enabled ? "on" : "off")}`, disabled: !it.toggleable, k: `tool:${it.id}`, onToggle: () => void setTool(it.id, !it.enabled) })))));
  }
  nodes.push(h("div", { class: "promise" }, icon("lock", 18), h("span", { text: t("promise") })));
  return nodes;
}
