// Fenêtre « Bienvenue » : l'état de la fenêtre et ce qu'elle demande au noyau (window.floppyOnboarding).
// Les pages lisent `S` et appellent ces fonctions ; `render()` redessine la page.
import { makeT, type Lang } from "./onboarding-i18n.ts";
import {
  GIB_BYTES, mergeSelection, selectionToApply, stepAt, startTab, tabOf, tr, type BrainTab, type Step,
} from "./onboarding-view.ts";
import { mic, startMic, stopMic } from "./onboarding-mic.ts";
import { stopSample } from "./onboarding-audio.ts";

export const api: FloppyOnboardingApi | undefined = window.floppyOnboarding;

export interface WindowState {
  lang: Lang;
  plan: OnboardingPlan | null;
  step: Step;
  /** Ce qui est choisi pour chaque rôle ; `touched` : les rôles que l'utilisateur a choisis lui-même. */
  sel: OnboardingSelection;
  touched: Set<OnboardingRole>;
  tab: BrainTab;
  /** « Voir le détail » ouvert, choix de la langue ouvert, liste des modèles d'écoute ouverte. */
  detail: boolean;
  langOpen: boolean;
  sttOpen: boolean;
  /** Mémoire choisie à la main, en Go (rien n'a été lu). */
  manual: number | null;
  inst: OnboardingState | null;
  extras: OnboardingExtras | null;
  error: string;
  busy: boolean;
}

export const S: WindowState = {
  lang: "fr", plan: null, step: "hello", sel: {}, touched: new Set(), tab: "local",
  detail: false, langOpen: false, sttOpen: false, manual: null, inst: null, extras: null, error: "", busy: false,
};

let paint: () => void = () => {};
/** La page se redessine par cette fonction (donnée par onboarding.ts). */
export const setPainter = (fn: () => void): void => { paint = fn; };
export const render = (): void => paint();

export const t = (key: string, vars?: Record<string, string | number>): string => makeT(S.lang)(key, vars);
/** Texte du noyau dans la langue de la fenêtre. */
export const txt = (x: AppText): string => tr(x, S.lang);

let listening = false;

/** Lit le plan (la machine, les choix, le conseil). Fenêtre rouverte pendant une installation : on revient à l'avancement. */
export async function load(opts: { fresh?: boolean; manualBytes?: number } = {}): Promise<void> {
  if (!api) return;
  S.busy = true; S.error = ""; render();
  const r = await api.plan(opts);
  S.busy = false;
  adopt(r, true);
}

/** Prend un plan reçu du noyau. `first` : la lecture de départ ou une relecture (pas un changement de langue). */
function adopt(r: OnboardingReply<OnboardingPlan> | null | undefined, first: boolean): void {
  if (!r?.ok || !r.value) { S.error = txt(r?.text) || t("failed"); render(); return; }
  const plan = r.value;
  const firstPlan = S.plan === null;
  S.plan = plan;
  if (plan.language === "fr" || plan.language === "en") S.lang = plan.language;
  else if (plan.lang === "fr" || plan.lang === "en") S.lang = plan.lang;
  document.documentElement.lang = S.lang;
  S.sel = mergeSelection(plan, S.sel, S.touched);
  if (firstPlan || !S.touched.has("brain")) S.tab = startTab(plan, S.sel);
  if (plan.state) S.inst = plan.state;
  if (plan.state && plan.state.phase !== "idle") S.step = "install";
  else if (first && !listening) { listening = true; void api?.prepareListening(); }
  render();
}

/** Change la langue de l'assistant (comme les Réglages) : le noyau recalcule le plan, la fenêtre change de langue. */
export async function changeLanguage(lang: Lang): Promise<void> {
  if (!api || S.busy) return;
  S.busy = true; S.error = ""; S.langOpen = false; render();
  const r = await api.setLanguage(lang, S.manual !== null ? { manualBytes: S.manual * GIB_BYTES } : {});
  S.busy = false;
  adopt(r, false);
}

/** Mémoire choisie à la main : le plan est relu avec cette mémoire. */
export function chooseManual(gib: number): void {
  S.manual = gib;
  void load({ manualBytes: gib * GIB_BYTES });
}

/** Choisit un modèle pour un rôle (le choix est celui de l'utilisateur : une relecture du plan le garde s'il existe encore). */
export function choose(role: OnboardingRole, value: string): void {
  S.sel = { ...S.sel, [role]: value };
  S.touched.add(role);
  if (role === "brain" && S.plan) S.tab = tabOf(S.plan, value) ?? S.tab;
  if (role === "stt") S.sttOpen = false;
  stopSample();
  render();
}

export function setTab(tab: BrainTab): void { S.tab = tab; stopSample(); render(); }

/** Les façons d'appeler Floppy et les connecteurs, relus (après un changement, ou en entrant dans l'écran). */
export async function refreshExtras(): Promise<void> {
  if (!api) return;
  const r = await api.extras();
  if (r?.ok && r.value) { S.extras = r.value; render(); }
}

/** Allume ou éteint une façon d'appeler Floppy (réglage des Réglages) ; la page est relue ensuite. */
export async function setWay(way: "wake" | "talk", on: boolean): Promise<void> {
  const w = S.extras?.ways[way];
  if (!api || !w) return;
  // Éteint : « @none » (mot d'activation) ou vide (raccourci). Allumé : la valeur qui rallume.
  const value = on ? w.fallback : way === "wake" ? "@none" : "";
  S.error = "";
  const r = await api.setWay(way, value);
  if (!r?.ok) S.error = txt(r?.text) || t("wayError");
  await refreshExtras();
  render();
}

/** Allume ou éteint un connecteur (même opération que dans les Réglages). */
export async function setTool(id: string, on: boolean): Promise<void> {
  if (!api) return;
  S.error = "";
  const r = await api.setTool(id, on);
  if (!r?.ok) S.error = txt(r?.text) || t("toolError");
  await refreshExtras();
  render();
}

/** Ce qui se passe en arrivant sur un écran (et en le quittant) : micro, extraits, façons d'appeler, connecteurs. */
function enter(step: Step): void {
  stopSample();
  S.sttOpen = false;
  if (step === "ears") { void refreshExtras(); startMic(render); } else stopMic();
  if (step === "tools") void refreshExtras();
}

export function goTo(step: Step): void {
  S.step = step; S.error = "";
  enter(step);
  render();
  document.querySelector('[role="radio"][aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
}

/** Étape suivante ou précédente ; après la dernière question : l'installation. */
export function go(delta: number): void {
  const next = stepAt(S.step, delta);
  if (next === "install" && S.step !== "install") { void install(); return; }
  goTo(next);
}

/** Envoie les choix au noyau, qui installe ; la fenêtre passe à l'avancement. */
export async function install(): Promise<void> {
  if (!api) return;
  S.busy = true; S.error = ""; render();
  const r = await api.apply(selectionToApply(S.sel));
  S.busy = false;
  if (!r?.ok) { S.error = txt(r?.text) || t("failed"); render(); return; }
  goTo("install");
}

/** Une installation a échoué : on revient aux choix (le plan est relu, l'état d'installation oublié). */
export function backToChoices(): void {
  S.inst = null;
  goTo("brain");
  void load({});
}

/** Reçoit l'avancement (l'écoute se télécharge dès « Bonjour » : la bulle et l'écran des oreilles le montrent aussi). */
export function onInstallState(s: OnboardingState): void {
  S.inst = s;
  render();
}

/** Le micro a-t-il entendu une voix ? */
export const micHeard = (): boolean => mic.status === "heard";
