// Fenêtre « Bienvenue » : la liste de choix d'un modèle (cerveau, écoute, voix), la même pour les trois écrans.
// Un `radiogroup` : une seule ligne dans l'ordre de tabulation, les flèches changent de ligne.
import { h, icon } from "./onboarding-dom.ts";
import { choose, S, t, txt } from "./onboarding-state.ts";
import { playingSample, toggleSample } from "./onboarding-audio.ts";
import { alreadyHere, languageTag, sizeText } from "./onboarding-view.ts";

/** Titre et phrase d'un écran. */
export function pageHead(title: string, lead: string): HTMLElement {
  return h("div", { class: "head" }, h("h1", { text: title, tabindex: "-1" }), h("p", { class: "lead", text: lead }));
}

/** Une ligne de la liste : rond de choix, nom et étiquettes, phrase, taille ou raison, bouton d'écoute. */
function pickRow(role: OnboardingRole, c: OnboardingChoice, plan: OnboardingPlan, selected: boolean, tab: boolean, next: (dir: number) => void): HTMLElement {
  const lang = S.lang;
  const label = txt(c.label);
  const note = languageTag(c, plan, lang);
  const size = sizeText(c, t, lang);
  const desc = txt(c.description) || (c.kind === "none" ? t("noVoiceDesc") : "");
  const playing = playingSample() === c.value;
  return h("div", {
    class: `pick${selected ? " on" : ""}${!c.fits && !selected ? " off" : ""}`, role: "radio", "aria-checked": String(selected), tabindex: tab ? "0" : "-1",
    "aria-disabled": !c.fits && !selected ? "true" : null, k: `${role}:${c.value}`,
    onclick: () => { if (c.fits || selected) choose(role, c.value); },
    onkeydown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (c.fits) choose(role, c.value); }
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); next(1); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); next(-1); }
    },
  },
  h("span", { class: "dot-r", "aria-hidden": "true" }, h("span")),
  h("div", { class: "pick-body" },
    h("span", { class: "pick-name" }, h("span", { class: "nm", text: label }),
      c.recommended ? h("span", { class: "chip", text: t("recommended") }) : null,
      alreadyHere(c) ? h("span", { class: "chip", text: t("already") }) : null,
      note ? h("span", { class: note.tone === "warn" ? "chip warn" : "chip plain", text: note.text }) : null),
    desc ? h("span", { class: "pick-desc", text: desc }) : null,
    size ? h("span", { class: "pick-size", text: size }) : null,
    !c.fits ? h("span", { class: "pick-warn", text: txt(c.reason) }) : null,
    !c.fits && selected ? h("span", { class: "pick-warn", text: t("forced") }) : null,
    !c.fits && !selected ? h("button", { type: "button", class: "btn small", text: t("tryAnyway"), k: `try:${role}:${c.value}`, onclick: (e: Event) => { e.stopPropagation(); choose(role, c.value); } }) : null),
  c.sample ? h("button", {
    type: "button", class: "round", "aria-label": t(playing ? "stopSample" : "listen", { name: label }), "aria-pressed": String(playing), k: `play:${c.value}`,
    onclick: (e: Event) => { e.stopPropagation(); toggleSample(c.value, c.sample!); },
  }, icon(playing ? "stop" : "play", 18)) : null);
}

/** La liste de choix d'un rôle ; le choix courant vient de `S.sel`. */
export function choiceList(role: OnboardingRole, choices: OnboardingChoice[], label: string): HTMLElement {
  const plan = S.plan!;
  const current = S.sel[role];
  const picked = choices.some((c) => c.value === current) ? current : choices.find((c) => c.fits)?.value;
  const fitting = choices.filter((c) => c.fits);
  const move = (from: string, dir: number) => {
    const i = fitting.findIndex((c) => c.value === from);
    const to = fitting[(i + dir + fitting.length) % fitting.length];
    if (to) choose(role, to.value);
  };
  return h("div", { class: "picks", role: "radiogroup", "aria-label": label },
    choices.map((c) => pickRow(role, c, plan, c.value === current, c.value === picked, (dir) => move(c.value, dir))));
}
