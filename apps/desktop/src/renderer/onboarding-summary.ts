// Fenêtre « Bienvenue » : la colonne de gauche (la bulle de Floppy et la liste des quatre morceaux), règles sans DOM.
import { chosen, earsReady, groupRows, hasSamples, PIECES, questionNumber, tr, waysSummary, type Piece, type Step, type Translate } from "./onboarding-view.ts";

export interface PieceItem {
  piece: Piece;
  state: "done" | "current" | "todo";
  name: string;
  /** « Question 2 sur 4 » (courant), la valeur choisie (fait), ou ce que fait ce morceau (à venir). */
  detail: string;
}

export interface SideInput {
  step: Step;
  plan: OnboardingPlan | null;
  sel: OnboardingSelection;
  extras: OnboardingExtras | null;
  inst: OnboardingState | null;
  lang: string;
  t: Translate;
}

/** La valeur choisie d'un morceau, pour la liste de gauche quand il est fait. */
function valueOf(piece: Piece, i: SideInput): string {
  if (piece === "brain") {
    const c = chosen(i.plan, "brain", i.sel);
    return c ? `${tr(c.label, i.lang)}, ${i.t(c.kind === "cloud" ? "online" : "atHome")}` : i.t("brain.sub");
  }
  if (piece === "ears") return waysSummary(i.extras?.ways, i.t);
  if (piece === "voice") {
    const c = chosen(i.plan, "tts", i.sel);
    return !c || c.kind === "none" ? i.t("noVoice") : tr(c.label, i.lang);
  }
  const on = i.extras?.tools.items.filter((x) => x.enabled).map((x) => tr(x.label, i.lang)) ?? [];
  return on.length ? on.join(", ") : i.t("noTools");
}

/** Les quatre morceaux : faits avant la question courante, courant, à venir (« Bonjour » : tous à venir ; installation : tous faits). */
export function pieceItems(i: SideInput): PieceItem[] {
  const q = questionNumber(i.step);
  return PIECES.map((piece, idx): PieceItem => {
    const state = i.step === "install" ? "done" : q === 0 ? "todo" : idx + 1 < q ? "done" : idx + 1 === q ? "current" : "todo";
    const detail = state === "current" ? i.t("questionOf", { n: q }) : state === "done" ? valueOf(piece, i) : i.t(`${piece}.sub`);
    return { piece, state, name: i.t(`${piece}.name`), detail };
  });
}

/** La phrase de la bulle (clé de texte) : Floppy parle à la première personne. */
export function bubbleKey(step: Step, plan: OnboardingPlan | null, inst: OnboardingState | null): string {
  const ears = groupRows(inst?.rows ?? []).find((g) => g.key === "ears");
  if (step === "ears") return ears && ears.state !== "ready" ? "bubble.earsWait" : "bubble.ears";
  if (step === "voice") return hasSamples(plan) ? "bubble.voice" : "bubble.voicePlain";
  if (step === "install") {
    return inst?.phase === "error" ? "bubble.error" : inst?.phase === "done" ? "bubble.done" : earsReady(inst) ? "bubble.installEars" : "bubble.install";
  }
  return `bubble.${step}`;
}
