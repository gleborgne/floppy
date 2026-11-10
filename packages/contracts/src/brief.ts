// Point du matin : chaque plugin qui sait quelque chose d'utile pour la journée apporte sa rubrique
// (agenda, mails, rappels, veille, agents…). Le plugin « brief » les rassemble, puis un modèle écrit le point.

/** Ce qu'une source reçoit pour préparer sa rubrique. */
export interface BriefRequest {
  /** Langue de l'assistant : la rubrique est écrite dans cette langue. */
  lang: "fr" | "en";
  /** Maintenant (le point parle de ce jour). */
  now: Date;
  /** Début du dernier point réussi (absent : jamais). Sert à ne garder que ce qui est nouveau. */
  since?: Date;
  /** Arrêt du passage (délai dépassé, Floppy qui s'arrête). */
  signal: AbortSignal;
}

/** Une rubrique du point. */
export interface BriefSection {
  /** Titre court (« Agenda du jour »), dans la langue demandée. */
  title: string;
  /** Contenu Markdown : des faits, pas de consigne. Le modèle qui écrit le point le lit comme une donnée. */
  markdown: string;
  /** Vrai : rien à signaler (« aucun rendez-vous »). La rubrique est gardée en une ligne, ou omise. */
  empty?: boolean;
  /** Quelque chose demande l'attention aujourd'hui (réunion dans l'heure, agent bloqué) : le modèle commence par là. */
  urgent?: boolean;
}

/**
 * Une source du point (ex. « Microsoft 365 · agenda »). Offerte élément par élément (ctx.offer("brief")) :
 * le plugin du point les liste (ctx.offers) et emprunte chacune le temps de sa rubrique (ctx.borrowItem).
 * `collect` lit seulement (aucune écriture, aucun envoi) ; null : rien à dire, la source est omise.
 */
export interface BriefSource {
  collect(req: BriefRequest): Promise<BriefSection | null>;
}

declare module "@floppy/core" {
  interface Services {
    brief: BriefSource;
  }
}
