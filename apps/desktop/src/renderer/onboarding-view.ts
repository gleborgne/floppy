// Fenêtre « Bienvenue » (premier lancement) : règles sans DOM, testées à part.
import { languageNote, type LanguageNote } from "./language-note.ts";

/** Texte simple, ou { fr, en } venu du noyau, dans la langue de la fenêtre. */
export type Lang = "fr" | "en";
/** Traducteur de la fenêtre : clé de texte -> texte. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export const tr = (x: AppText, lang: string): string => (x && typeof x === "object" ? (lang === "en" ? x.en : x.fr) ?? x.fr ?? "" : String(x ?? ""));

const GIB = 1024 ** 3;
/** Octets d'un Go (le choix de mémoire à la main se compte en Go). */
export const GIB_BYTES = GIB;

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

// ------------------------------------------------------------------ étapes
/** Les étapes : bonjour, les quatre questions, puis l'installation. */
export type Step = "hello" | "brain" | "ears" | "voice" | "tools" | "install";
export const STEPS: Step[] = ["hello", "brain", "ears", "voice", "tools", "install"];
/** Les quatre morceaux de la colonne de gauche, dans l'ordre des questions. */
export type Piece = "brain" | "ears" | "voice" | "tools";
export const PIECES: Piece[] = ["brain", "ears", "voice", "tools"];

/** Étape voisine (`delta` -1 ou 1) ; au bout de la liste, l'étape elle-même. */
export function stepAt(step: Step, delta: number): Step {
  return STEPS[Math.min(STEPS.length - 1, Math.max(0, STEPS.indexOf(step) + delta))] ?? step;
}
/** Numéro de la question (1 à 4) de l'étape, 0 pour « bonjour » et l'installation. */
export const questionNumber = (step: Step): number => PIECES.indexOf(step as Piece) + 1;

/** Rôle de choix d'un morceau (les outils n'ont pas de modèle). */
export const ROLE_OF_PIECE: Record<Exclude<Piece, "tools">, OnboardingRole> = { brain: "brain", ears: "stt", voice: "tts" };

// ------------------------------------------------------------------ choix
/**
 * Les choix après une nouvelle lecture du plan (langue changée, machine relue) : ce que l'utilisateur a choisi lui-même et
 * qui existe encore est gardé, le reste suit le conseil du plan. La première fois : le conseil.
 */
export function mergeSelection(plan: OnboardingPlan, current: OnboardingSelection, touched: ReadonlySet<OnboardingRole>): OnboardingSelection {
  const out: OnboardingSelection = {};
  for (const role of ["brain", "stt", "tts"] as OnboardingRole[]) {
    const keep = touched.has(role) && current[role] !== undefined && plan.choices[role].some((c) => c.value === current[role]);
    const value = keep ? current[role] : plan.recommended[role];
    if (value !== undefined) out[role] = value;
  }
  return out;
}

/** Où tourne le cerveau : « local » (chez toi) ou « cloud » (en ligne). */
export type BrainTab = "local" | "cloud";
/** Onglet ouvert au départ : celui du cerveau choisi (le conseil), « chez toi » à défaut. */
export function startTab(plan: OnboardingPlan, sel: OnboardingSelection): BrainTab {
  return plan.choices.brain.find((c) => c.value === sel.brain)?.kind === "cloud" ? "cloud" : "local";
}
/** Les cerveaux d'un onglet : « chez toi » = modèles locaux, « en ligne » = cerveaux cloud (et programmes à ajouter). */
export const brainsOf = (plan: OnboardingPlan, tab: BrainTab): OnboardingChoice[] => plan.choices.brain.filter((c) => (tab === "cloud" ? c.kind === "cloud" : c.kind !== "cloud"));
/** Un cerveau en ligne est-il prêt (offert avec son programme, ou trouvé et à ajouter) ? */
export const hasReadyCloud = (plan: OnboardingPlan): boolean => plan.choices.brain.some((c) => c.kind === "cloud" && c.fits);
/** L'onglet d'un cerveau choisi (pour suivre son choix). */
export const tabOf = (plan: OnboardingPlan, value: string | undefined): BrainTab | undefined => {
  const kind = plan.choices.brain.find((c) => c.value === value)?.kind;
  return kind === undefined ? undefined : kind === "cloud" ? "cloud" : "local";
};

/** Taille à télécharger d'un choix (« À télécharger : 9,5 Go »), vide s'il n'y a rien à télécharger. */
export const sizeText = (c: OnboardingChoice, t: Translate, lang: string): string => (c.kind !== "cloud" && c.kind !== "none" && c.size > 0 ? `${t("toDownload")}${gb(c.size, lang)}` : "");

/** Le modèle est déjà sur l'ordinateur : rien à attendre (« Déjà sur ton ordinateur »). Un cerveau en ligne et « pas de voix » : non. */
export const alreadyHere = (c: OnboardingChoice): boolean => c.installed && c.size === 0 && (c.kind === "local" || c.kind === "offered");

/** Étiquette de langue d'un choix pour la langue de l'assistant (jaune si elle est mal gérée), null si inconnue. */
export const languageTag = (c: OnboardingChoice, plan: OnboardingPlan, lang: string): LanguageNote | null => languageNote(c.language, plan.language, lang);

/** Le choix d'un rôle d'après la sélection. */
export const chosen = (plan: OnboardingPlan | null, role: OnboardingRole, sel: OnboardingSelection): OnboardingChoice | undefined => plan?.choices[role].find((c) => c.value === sel[role]);

/** Il y a un extrait sonore à écouter dans les choix de voix. */
export const hasSamples = (plan: OnboardingPlan | null): boolean => !!plan?.choices.tts.some((c) => !!c.sample);

/** Sélection envoyée à `apply` : ce qui est choisi, rien d'autre. */
export function selectionToApply(sel: OnboardingSelection): OnboardingSelection {
  return { ...(sel.brain !== undefined ? { brain: sel.brain } : {}), ...(sel.stt !== undefined ? { stt: sel.stt } : {}), ...(sel.tts !== undefined ? { tts: sel.tts } : {}) };
}

// ------------------------------------------------------------------ bonjour
/** Ce que la machine permet, en une phrase : tout chez toi, cerveau en ligne, juste, ou rien de lu. */
export type Verdict = "full" | "cloud" | "tight" | "unread";
export function machineVerdict(plan: OnboardingPlan): Verdict {
  if (needsManual(plan)) return "unread";
  const brain = plan.choices.brain.find((c) => c.value === plan.recommended.brain);
  if (!brain) return "tight";
  return brain.kind === "cloud" ? "cloud" : "full";
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

// ------------------------------------------------------------------ oreilles
/** Raccourci à montrer : `Ctrl+Alt+…` s'écrit ⌃⌥ sur Mac. */
export const keysText = (keys: string, mac: boolean): string => (mac ? keys.replaceAll("Ctrl+Alt+", "⌃⌥") : keys);

/** « Mon nom, ou le clavier » : ce qui est allumé parmi les façons d'appeler Floppy. */
export function waysSummary(ways: OnboardingWays | null | undefined, t: Translate): string {
  const wake = !!ways?.wake?.on, keys = !!ways?.talk?.keys;
  return wake && keys ? t("waysBoth") : wake ? t("waysWake") : keys ? t("waysKeys") : t("waysNone");
}

/** Niveau du micro de 0 à 1, d'après un échantillon temporel d'un AnalyserNode (octets centrés sur 128). */
export function micLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = (samples[i]! - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
/** Au-dessus de ce niveau, on a entendu une voix. */
export const MIC_HEARD = 0.08;

/** Hauteur de chaque barre (0 à 1) : le niveau, creusé aux bords, pour une forme de voix. */
export function barLevels(level: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const mid = 1 - Math.abs((i + 0.5) / count - 0.5) * 1.2;
    return Math.max(0.08, Math.min(1, level * mid * (0.75 + 0.25 * Math.sin(i * 2.1))));
  });
}

// ------------------------------------------------------------------ installation
/** Les trois morceaux qui se téléchargent : l'écoute (détecteur, transcription, leur programme), la voix, le cerveau. */
export type Group = "ears" | "voice" | "brain";
export interface RowGroup {
  key: Group;
  state: "waiting" | "downloading" | "ready" | "error";
  /** 0 à 1, moyenne des lignes (une ligne prête compte pour 1). */
  progress: number;
  rows: OnboardingRow[];
  /** Texte de la première erreur. */
  error?: AppText;
}
const GROUP_OF: Record<string, Group | undefined> = { vad: "ears", stt: "ears", tts: "voice", llm: "brain" };
/** Début de la clé d'une ligne (le fournisseur) : un programme se range avec les modèles de son fournisseur. */
const providerOf = (r: OnboardingRow): string => (r.key ?? "").split("/")[0] ?? "";

/**
 * Regroupe les lignes d'installation par morceau, dans l'ordre ears, voice, brain (un groupe vide n'existe pas).
 * Un programme (llama.cpp, audio.cpp) précède ses modèles : il va avec le premier modèle suivant du même fournisseur,
 * sinon avec le suivant, sinon avec le dernier groupe.
 */
export function groupRows(rows: OnboardingRow[]): RowGroup[] {
  const by: Record<Group, OnboardingRow[]> = { ears: [], voice: [], brain: [] };
  let pending: OnboardingRow[] = [];
  let last: Group | undefined;
  for (const r of rows) {
    const g = GROUP_OF[r.role];
    if (!g) { pending.push(r); continue; }
    const mine = pending.filter((p) => providerOf(p) === providerOf(r));
    const mates = mine.length ? mine : pending;
    by[g].push(...mates, r);
    pending = pending.filter((p) => !mates.includes(p));
    last = g;
  }
  if (pending.length) by[last ?? "ears"].push(...pending);
  return (["ears", "voice", "brain"] as Group[]).filter((k) => by[k].length).map((key) => {
    const list = by[key];
    const state = list.some((r) => r.state === "error") ? "error" : list.every((r) => r.state === "ready") ? "ready"
      : list.some((r) => r.state === "downloading" || r.state === "ready") ? "downloading" : "waiting";
    const progress = list.reduce((n, r) => n + (r.state === "ready" ? 1 : r.progress ?? 0), 0) / list.length;
    const bad = list.find((r) => r.state === "error" && r.text);
    return { key, state, progress, rows: list, ...(bad ? { error: bad.text } : {}) };
  });
}

/** Texte d'une ligne d'installation : « 42 % », « Prêt », l'erreur… */
export function rowStatus(row: OnboardingRow, t: Translate, lang: string): string {
  if (row.state === "downloading") return typeof row.progress === "number" ? `${Math.floor(row.progress * 100)}${lang === "en" ? "%" : " %"}` : t("downloading");
  if (row.state === "ready") return t("ready");
  if (row.state === "error") return tr(row.text, lang) || t("failed");
  return t("waiting");
}

/** « 42 % » / « 42% » : avancement d'un groupe. */
export const percent = (progress: number, lang: string): string => `${Math.floor(Math.max(0, Math.min(1, progress)) * 100)}${lang === "en" ? "%" : " %"}`;

/** L'écoute est-elle prête (rien à attendre : on peut parler) ? Sans ligne d'installation : on ne sait pas, pas prête. */
export const earsReady = (state: OnboardingState | null | undefined): boolean => groupRows(state?.rows ?? []).find((g) => g.key === "ears")?.state === "ready";

/** Résumé de l'installation de départ pour les réglages : titre, nombre de morceaux prêts, en cours ? (rien : null). */
export function installSummary(state: OnboardingState | null | undefined): { running: boolean; ready: number; total: number; failed: boolean } | null {
  if (!state || state.phase === "idle" || !state.rows?.length) return null;
  const ready = state.rows.filter((r) => r.state === "ready").length;
  return { running: state.phase === "installing" || state.phase === "testing", ready, total: state.rows.length, failed: state.phase === "error" };
}
