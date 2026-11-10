// Fenêtre « Bienvenue » : l'écran d'installation : une ligne par morceau (oreilles, voix, cerveau), les phrases du noyau, la fin.
import { h, icon, progressBar } from "./onboarding-dom.ts";
import { S, t, txt } from "./onboarding-state.ts";
import { pageHead } from "./onboarding-list.ts";
import { earsReady, groupRows, percent, type RowGroup } from "./onboarding-view.ts";

/** Phrase d'un morceau : prêt, en route, ou à venir ; avec le cerveau du cloud en attendant s'il répond déjà. */
function groupText(g: RowGroup, live: boolean, phase: string): string {
  if (g.state === "error") return txt(g.error) || t("failed");
  if (g.key === "brain" && phase === "testing") return t("testing");
  const state = g.state === "downloading" || g.state === "ready" ? g.state : "waiting";
  return t(`g.${g.key}.${state}`) + (g.key === "brain" && state !== "ready" && live ? t("liveSuffix") : "");
}

function groupLine(g: RowGroup, live: boolean, phase: string): HTMLElement {
  const name = t(`g.${g.key}`);
  const status = g.state === "ready" ? t("ready") : g.state === "error" ? "" : g.state === "downloading" ? percent(g.progress, S.lang) : t("later");
  return h("div", { class: "line inst" }, h("span", { class: `lic${g.state === "ready" ? " good" : g.state === "error" ? " bad" : ""}` }, icon(g.state === "ready" ? "check" : g.key, 22)),
    h("div", { class: "line-text" }, h("span", { class: "t", text: name }),
      g.state === "downloading" ? progressBar(g.progress, name) : null,
      h("span", { class: g.state === "error" ? "s bad" : "s", text: groupText(g, live, phase) })),
    status ? h("span", { class: g.state === "ready" ? "st ok" : "st", text: status }) : null);
}

export function installPage(): HTMLElement[] {
  const s = S.inst ?? { phase: "installing", rows: [], notes: [] };
  const groups = groupRows(s.rows);
  const title = s.phase === "done" ? t("install.done") : s.phase === "error" ? t("install.error") : earsReady(s) ? t("install.titleEars") : t("install.title");
  const nodes: HTMLElement[] = [pageHead(title, s.phase === "done" || s.phase === "error" ? "" : t("install.lead"))];
  if (groups.length) nodes.push(h("div", { class: "card lines" }, groups.map((g) => groupLine(g, s.live === true, s.phase))));
  if (s.phase === "testing" && !groups.some((g) => g.key === "brain")) nodes.push(h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("testing") })));
  if (s.notes.length) nodes.push(h("ul", { class: "notes" }, s.notes.map((n) => h("li", { text: txt(n) }))));
  if (s.phase !== "done" && s.phase !== "error") nodes.push(h("p", { class: "hint", text: t("install.foot") }));
  return nodes;
}
