// Fenêtre « Bienvenue » (premier lancement) : règles sans DOM, testées à part.

/** Texte simple, ou { fr, en } venu du noyau, dans la langue de la fenêtre. */
export type Lang = "fr" | "en";
/** Traducteur de la fenêtre : clé de texte -> texte. */
export type Translate = (key: string) => string;
export const tr = (x: AppText, lang: string): string => (x && typeof x === "object" ? (lang === "en" ? x.en : x.fr) ?? x.fr ?? "" : String(x ?? ""));

const GIB = 1024 ** 3;

/** « 9,5 Go » / « 9.5 GB » (arrondi à 0,5). */
export function gb(bytes: number | undefined, lang: string): string {
  const v = Math.round(((bytes ?? 0) / GIB) * 2) / 2;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return lang === "en" ? `${s} GB` : `${s.replace(".", ",")} Go`;
}

/** Choix à la main quand rien n'a été lu sur la machine (Go pour les modèles ; 0 = pas de puce graphique). */
export const MANUAL_CHOICES = [0, 8, 12, 16, 24];

/** Rien n'a été lu (aucune sonde n'a répondu) : la fenêtre propose le choix à la main. */
export const needsManual = (plan: OnboardingPlan | null): boolean => !plan?.machine?.sources?.length;

/** Étapes de la fenêtre pour un niveau : l'étape « cerveau dans le cloud » seulement si le niveau en a besoin. */
export function stepsFor(level: OnboardingLevel | undefined | null): string[] {
  return level?.brain === "cloud" ? ["machine", "level", "brain", "install"] : ["machine", "level", "install"];
}

/** Lignes du résumé de la machine : [libellé, valeur]. */
export function machineRows(m: OnboardingMachine, t: Translate, lang: string): [string, string][] {
  const rows: [string, string][] = [];
  if (m.gpu) {
    rows.push([t("chip"), m.gpu.name]);
    rows.push([t("memoryKind"), m.memory === "unified" ? t("unified") : t("dedicated")]);
    rows.push([t("forModels"), gb(m.modelBytes, lang)]);
  } else rows.push([t("chip"), t("noChip")]);
  rows.push([t("ram"), gb(m.ramBytes, lang)]);
  if (typeof m.diskFreeBytes === "number") rows.push([t("disk"), gb(m.diskFreeBytes, lang)]);
  return rows;
}

/** Résumé d'un niveau : les modèles choisis et ce qu'il faut télécharger, ou la raison qui l'empêche. */
export function levelFacts(level: OnboardingLevel, t: Translate, lang: string): { models: string; note: string; warn: boolean } {
  const models = level.picks.map((p) => tr(p.label, lang)).join(" · ");
  if (!level.possible) return { models, note: tr(level.reason, lang), warn: true };
  return { models, note: level.downloadBytes > 0 ? `${t("toDownload")} ${gb(level.downloadBytes, lang)}` : t("nothingToDownload"), warn: false };
}

/** Texte d'une ligne d'installation : « 42 % », « Prêt », l'erreur… */
export function rowStatus(row: OnboardingRow, t: Translate, lang: string): string {
  if (row.state === "downloading") return typeof row.progress === "number" ? `${Math.floor(row.progress * 100)}${lang === "en" ? "%" : " %"}` : t("downloading");
  if (row.state === "ready") return t("ready");
  if (row.state === "error") return tr(row.text, lang) || t("failed");
  return t("waiting");
}

/** Niveau choisi au départ : le conseil, sinon le premier possible. */
export function defaultLevel(plan: OnboardingPlan): string | undefined {
  return plan.levels.find((l) => l.id === plan.recommended)?.id ?? plan.levels.find((l) => l.possible)?.id ?? plan.levels[0]?.id;
}

/** Résumé de l'installation de départ pour les réglages : titre, nombre de morceaux prêts, en cours ? (rien : null). */
export function installSummary(state: OnboardingState | null | undefined): { running: boolean; ready: number; total: number; failed: boolean } | null {
  if (!state || state.phase === "idle" || !state.rows?.length) return null;
  const ready = state.rows.filter((r) => r.state === "ready").length;
  return { running: state.phase === "installing" || state.phase === "testing", ready, total: state.rows.length, failed: state.phase === "error" };
}
