// Fenêtre « Bienvenue » (premier lancement) : bonjour, quatre questions (cerveau, oreilles, voix, outils), puis l'installation.
// Colonne de gauche : Floppy qui parle et la liste des quatre morceaux ; colonne de droite : l'écran, et Retour / Continuer.
// Tout vient du noyau (window.floppyOnboarding) ; les textes de la fenêtre sont dans onboarding-i18n.ts (fr / en).
// Tout texte venu du noyau est inséré avec textContent : jamais de innerHTML.
import { h, icon } from "./onboarding-dom.ts";
import { api, backToChoices, go, load, onInstallState, render, S, setPainter, t } from "./onboarding-state.ts";
import { onSampleChange } from "./onboarding-audio.ts";
import { bubbleKey, pieceItems } from "./onboarding-summary.ts";
import { helloPage } from "./onboarding-hello.ts";
import { brainPage, voicePage } from "./onboarding-choices.ts";
import { earsPage } from "./onboarding-ears.ts";
import { toolsPage } from "./onboarding-tools.ts";
import { installPage } from "./onboarding-install.ts";
import { questionNumber } from "./onboarding-view.ts";

// Éléments de la page : ils existent dans onboarding.html (pas de repli).
const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Colonne de gauche : la bulle, l'avatar (aperçu fixe, ou des anneaux) et les quatre morceaux. */
function side(): void {
  $("bubble").textContent = t(bubbleKey(S.step, S.plan, S.inst));
  const avatar = $("avatar");
  if (S.plan?.avatar) {
    avatar.className = "avatar still";
    avatar.replaceChildren(h("img", { src: S.plan.avatar, alt: "", width: "140", height: "140" }));
  } else {
    avatar.className = "avatar rings";
    avatar.replaceChildren(h("span", { class: "r1" }), h("span", { class: "r2" }), h("span", { class: "r3" }), h("span", { class: "core" }));
  }
  $("pieces").setAttribute("aria-label", t("pieces"));
  $("pieces").replaceChildren(...pieceItems({ step: S.step, plan: S.plan, sel: S.sel, extras: S.extras, inst: S.inst, lang: S.lang, t }).map((p) => h("li", {
    class: `piece ${p.state}`, ...(p.state === "current" ? { "aria-current": "step" } : {}),
  }, p.state === "done" ? icon("check", 18) : icon(p.piece, 18),
  h("span", { class: "piece-text" }, h("span", { class: "n", text: p.name }), h("span", { class: "d", text: p.detail })))));
}

/** Pied : Retour / Continuer (ou Passer, C'est parti ; Revenir aux choix, Fermer pendant l'installation). */
function actions(): HTMLElement[] {
  const btn = (text: string, onclick: () => void, o: { pri?: boolean; link?: boolean; disabled?: boolean; k?: string } = {}) => h("button", {
    type: "button", class: o.link ? "btn link" : o.pri ? "btn big pri" : "btn big", text, onclick, disabled: o.disabled || S.busy, k: o.k ?? text,
  });
  const skip = () => btn(t("skip"), async () => { await api?.skip(); api?.close(); }, { link: true, k: "skip" });
  const grow = h("span", { class: "grow" });
  if (S.step === "install") {
    const phase = S.inst?.phase;
    const out = [];
    if (phase === "error") out.push(btn(t("backToChoices"), backToChoices, { k: "again" }));
    out.push(grow, btn(t("close"), () => api?.close(), { pri: phase === "done" || S.inst?.live === true || phase === "error", k: "close" }));
    return out;
  }
  if (S.step === "hello") return [skip(), grow, btn(t("go"), () => go(1), { pri: true, disabled: !S.plan, k: "next" })];
  const last = S.step === "tools";
  const blocked = S.step === "brain" && !S.sel.brain;
  return [skip(), grow, btn(t("back"), () => go(-1), { k: "back" }), btn(t(last ? "finish" : "next"), () => go(1), { pri: true, disabled: blocked, k: "next" })];
}

function page(): HTMLElement[] {
  if (!api) return [h("p", { class: "lead", text: t("noApi") })];
  switch (S.step) {
    case "brain": return brainPage();
    case "ears": return earsPage();
    case "voice": return voicePage();
    case "tools": return toolsPage();
    case "install": return installPage();
    default: return helloPage();
  }
}

let lastStep = "";
/** Dessine tout, en gardant le défilement et le focus (l'avancement de l'installation redessine souvent la page). */
function paint(): void {
  document.title = `Floppy — ${t("title")}`;
  const content = $("content");
  const top = content.scrollTop;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
  side();
  const nodes = page();
  if (S.error) nodes.push(h("p", { class: "hint bad", role: "alert", text: S.error }));
  content.replaceChildren(...nodes);
  $("actions").replaceChildren(...(api ? actions() : []));
  const same = lastStep === S.step;
  lastStep = S.step;
  if (same) {
    content.scrollTop = top;
    if (focused) document.querySelector<HTMLElement>(`[data-k="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  } else {
    content.scrollTop = 0;
    if (questionNumber(S.step) > 0 || S.step === "install") content.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }
}

setPainter(paint);
onSampleChange(render);
if (api) {
  api.onState(onInstallState);
  void load({});
}
paint();
