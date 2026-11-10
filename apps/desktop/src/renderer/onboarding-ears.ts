// Fenêtre « Bienvenue » : l'écran « oreilles » : le modèle d'écoute, les façons d'appeler Floppy (réglages réels) et l'essai du micro.
import { h, icon, progressBar, switchBtn } from "./onboarding-dom.ts";
import { render, S, setWay, t, txt } from "./onboarding-state.ts";
import { choiceList, pageHead } from "./onboarding-list.ts";
import { BARS, mic } from "./onboarding-mic.ts";
import { chosen, groupRows, keysText, percent } from "./onboarding-view.ts";

const isMac = (): boolean => /Mac/i.test(navigator.platform || navigator.userAgent);

/** Une façon d'appeler Floppy : icône, nom, phrase, interrupteur. */
function way(ic: string, name: string, sub: string, on: boolean, toggle: () => void, disabled: boolean, k: string): HTMLElement {
  return h("div", { class: "line way" }, h("span", { class: "lic" }, icon(ic, 22)),
    h("div", { class: "line-text" }, h("span", { class: "t", text: name }), h("span", { class: "s", text: sub })),
    switchBtn({ on, label: `${name} : ${t(on ? "on" : "off")}`, disabled, k, onToggle: toggle }));
}

/** Le micro : barres de niveau et une phrase sur ce qu'on entend. */
function micCard(): HTMLElement {
  const msg = mic.status === "heard" ? t("micOk") : mic.status === "denied" ? t("micDenied") : mic.status === "none" ? t("micNone")
    : mic.status === "starting" ? t("micStarting") : t("micPrompt");
  const ok = mic.status === "heard";
  const bad = mic.status === "denied" || mic.status === "none";
  const bars = Array.from({ length: BARS }, () => h("i"));
  return h("div", { class: `card mic${ok ? " ok" : ""}`, role: "status" },
    h("span", { class: `lic${bad ? " warn" : ok ? " good" : ""}` }, icon("mic", 22)),
    h("div", { class: "mic-body" }, h("span", { class: "s", text: msg }), h("div", { class: "mic-bars", "aria-hidden": "true" }, bars)));
}

export function earsPage(): HTMLElement[] {
  const plan = S.plan;
  const nodes: HTMLElement[] = [pageHead(t("ears.title"), t("ears.lead"))];
  if (!plan) return nodes;
  const stt = chosen(plan, "stt", S.sel);
  if (!plan.choices.stt.length) nodes.push(h("p", { class: "hint", text: t("noStt") }));
  else if (S.sttOpen) {
    nodes.push(choiceList("stt", plan.choices.stt, t("earsList")));
    nodes.push(h("div", {}, h("button", { type: "button", class: "btn small", text: t("back"), k: "stt-close", onclick: () => { S.sttOpen = false; render(); } })));
  } else if (stt) {
    nodes.push(h("div", { class: "card" }, h("div", { class: "line" }, h("span", { class: "lic" }, icon("ears", 22)),
      h("div", { class: "line-text" },
        h("span", { class: "t" }, h("span", { text: t("earsModel", { name: txt(stt.label) }) }), stt.recommended ? h("span", { class: "chip", text: t("recommended") }) : null),
        h("span", { class: "s", text: txt(stt.description) })),
      plan.choices.stt.length > 1 ? h("button", { type: "button", class: "btn small", text: t("changeModel"), k: "stt-open", onclick: () => { S.sttOpen = true; render(); } }) : null)));
  }
  // Façons d'appeler Floppy : seulement celles dont le réglage existe ; l'interrupteur change ce réglage.
  const ways = S.extras?.ways;
  const rows: HTMLElement[] = [];
  if (ways?.wake) rows.push(way("chat", t("wakeName"), t("wakeDesc"), ways.wake.on, () => void setWay("wake", !ways.wake!.on), false, "way:wake"));
  if (ways?.talk) {
    const keys = keysText(ways.talk.keys || ways.talk.fallback, isMac());
    rows.push(way("keyboard", t("keysName"), keys ? t("keysDesc", { keys }) : "", !!ways.talk.keys, () => void setWay("talk", !ways.talk!.keys), !ways.talk.keys && !ways.talk.fallback, "way:talk"));
  }
  if (rows.length) nodes.push(h("div", { class: "card lines" }, rows));
  nodes.push(micCard());
  // L'écoute se télécharge encore : on le dit, et on peut continuer.
  const ears = groupRows(S.inst?.rows ?? []).find((g) => g.key === "ears");
  if (ears && ears.state !== "ready") {
    nodes.push(h("div", { class: "card wait-card" }, progressBar(ears.progress, t("earsProgress")), h("p", { class: "s", text: t("earsWait", { pct: percent(ears.progress, S.lang) }) })));
  }
  return nodes;
}
