// Canaux d'envoi (Telegram, mail…) : un plugin envoie un message par un canal choisi.

/** Ce qu'on envoie : un titre et un texte Markdown (le canal le met en forme : HTML pour un mail, message Telegram…). */
export interface NotifyMessage {
  titre: string;
  markdown: string;
}

/**
 * Un canal d'envoi configuré (ex. « Telegram · mon canal », « Gmail · perso »). Offert élément par élément
 * (ctx.offer("notify")) : un plugin les liste (ctx.offers) et en emprunte un le temps d'un envoi (ctx.borrowItem).
 * Envoyer, c'est sortir de chez l'utilisateur : celui qui envoie a l'accord (réglage choisi, ou outil de niveau « send »).
 */
export interface NotifyService {
  label?: string;
  cloud?: boolean;
  send(msg: NotifyMessage, opts?: { signal?: AbortSignal }): Promise<void>;
}

declare module "@floppy/core" {
  interface Services {
    notify: NotifyService;
  }
}
