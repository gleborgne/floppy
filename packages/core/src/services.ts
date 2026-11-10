import type { Text } from "./i18n.ts";

/** Fournisseur prêt ou non. `reason` : en clair, dans la langue de l'assistant ; `reasonText` : en français et en anglais. */
export interface Availability {
  ready: boolean;
  reason?: string;
  reasonText?: Text;
}

// Registre des types de services. Le noyau n'y met que ses propres contrats (tâches, documents qui montrent
// leur résultat). Les autres vivent dans @floppy/contracts, rangés par domaine, et s'ajoutent ici par
// augmentation de module, comme dans Cordis :
//   declare module "@floppy/core" { interface Services { monService: MonType } }

// ------------------------------------------------------------------ documents Markdown (« artefacts »)
export interface DocRef {
  id: string;
  title: string;
  /** ISO 8601. */
  date: string;
  source: string;
  tags: string[];
}

/** Les documents Markdown de Floppy (veille, résumés) : les ranger, les lister, les montrer sur un corps. */
export interface DocumentsService {
  /** Enregistre un document Markdown (fichier dans <home>/documents). */
  save(doc: { title: string; markdown: string; source: string; tags?: string[] }): Promise<DocRef>;
  /**
   * Montre un document. `target` : un corps précis, sinon le corps d'origine s'il sait afficher, sinon le premier corps
   * qui sait afficher. Un corps texte reçoit le Markdown ; un corps voix seule, rien (l'appelant dit un résumé).
   * Rend l'id du corps qui l'affiche, ou undefined.
   */
  show(id: string, target?: string): Promise<string | undefined>;
  list(filter?: { tag?: string; max?: number }): Promise<DocRef[]>;
  get(id: string): Promise<(DocRef & { markdown: string }) | undefined>;
  /** Supprime un document (son fichier). Faux : il n'existait pas. */
  remove?(id: string): Promise<boolean>;
}

// ------------------------------------------------------------------ tâches (veille, résumés…)
/** Pourquoi une tâche tourne. */
export type TaskReason = "clock" | "voice" | "manual";

export interface TaskRunInput {
  signal: AbortSignal;
  reason: TaskReason;
  /** Fin du dernier passage réussi (absent : jamais). */
  lastRun?: Date;
}

export interface TaskResult {
  /** Une ou deux phrases, dites ou montrées à l'utilisateur (« Ta veille est prête : 14 articles. »). */
  summary: string;
  /** Document produit : le noyau le montre (service documents). */
  document?: DocRef;
  /** important : dit à voix haute ; normal : notification ; silent : rien (défaut : normal). */
  announce?: "important" | "normal" | "silent";
}

/**
 * Un plugin qui a des tâches les déclare dans son manifeste (`tasks`) et fournit ce service. Le noyau les lance
 * (horloge du plugin Planificateur, voix…), une à la fois, et annonce le résultat : la tâche ne connaît ni l'horloge ni les corps.
 */
export interface TaskService {
  run(taskId: string, input: TaskRunInput): Promise<TaskResult>;
}

/** Nom d'un service connu (une clé de `Services`). Un plugin qui a son propre service l'ajoute par augmentation de module. */
export type ServiceName = keyof Services & string;

export interface Services {
  documents: DocumentsService;
  task: TaskService;
}
