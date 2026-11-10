// Fenêtre « Bienvenue » : les écrans « cerveau » (chez toi / en ligne) et « voix » (avec les extraits).
import { h } from "./onboarding-dom.ts";
import { api, S, setTab, t } from "./onboarding-state.ts";
import { choiceList, pageHead } from "./onboarding-list.ts";
import { brainsOf, hasReadyCloud, hasSamples, type BrainTab } from "./onboarding-view.ts";

export function brainPage(): HTMLElement[] {
  const plan = S.plan;
  const nodes: HTMLElement[] = [pageHead(t("brain.title"), t("brain.lead"))];
  if (!plan) return nodes;
  const tab = (id: BrainTab, text: string) => h("button", {
    type: "button", role: "radio", "aria-checked": String(S.tab === id), text, k: `tab:${id}`, onclick: () => setTab(id),
  });
  nodes.push(h("div", { class: "seg wide", role: "radiogroup", "aria-label": t("brainWhere") }, tab("local", t("tabLocal")), tab("cloud", t("tabCloud"))));
  const list = brainsOf(plan, S.tab);
  // En ligne sans aucun cerveau prêt : on dit comment en avoir un.
  if (S.tab === "cloud" && !hasReadyCloud(plan)) {
    nodes.push(h("p", { class: "hint", text: t("noCloud") }));
    nodes.push(h("div", {}, h("button", { type: "button", class: "btn", text: t("openSettings"), k: "settings", onclick: () => api?.openSettings() })));
  }
  if (list.length) nodes.push(choiceList("brain", list, t("brainList")));
  else if (S.tab === "local") nodes.push(h("p", { class: "hint", text: t("brainNone") }));
  nodes.push(h("p", { class: "hint", text: t("brain.foot") }));
  return nodes;
}

export function voicePage(): HTMLElement[] {
  const plan = S.plan;
  const samples = hasSamples(plan);
  const nodes: HTMLElement[] = [pageHead(t("voice.title"), t(samples ? "voice.lead" : "voice.leadPlain"))];
  if (!plan) return nodes;
  nodes.push(choiceList("tts", plan.choices.tts, t("voiceList")));
  nodes.push(h("p", { class: "hint", text: t("voice.foot") }));
  return nodes;
}
