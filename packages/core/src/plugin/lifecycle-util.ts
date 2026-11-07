// Petites pièces du cycle de vie, sans état : événements réservés, comparaison d'entrées, éléments d'une offre,
// délai d'un démarrage. Séparées de kernel.ts pour qu'il garde seulement la table des entrées et leur cycle.
import type { EntryConfig } from "../config/schema.ts";
import { stableStringify } from "../util/process.ts";
import type { OfferDef, OfferItem } from "./context.ts";

/** Événements émis seulement par le noyau (ctx.emit les refuse aux plugins). */
export const KERNEL_EVENTS = new Set(["approval.request", "approval.closed", "plugin.state", "service.changed", "task.done", "floppy.restart"]);

export function sameEntry(a: EntryConfig, b: EntryConfig): boolean {
  return a.plugin === b.plugin && a.disabled === b.disabled && stableStringify(a.config) === stableStringify(b.config);
}

/** Éléments d'une offre ; une offre qui plante ne casse pas la liste. */
export function offerItems(offer: OfferDef<any>): OfferItem[] {
  try { return offer.items(); } catch { return []; }
}

/** Délai d'un démarrage, qu'on peut mettre en pause (le temps d'attendre un autre plugin ne compte pas). */
export class Deadline {
  private left: number;
  private since = 0;
  private timer: NodeJS.Timeout | undefined;
  private paused = 0;
  private done = false;
  private readonly onTimeout: () => void;

  constructor(ms: number, onTimeout: () => void) {
    this.left = ms;
    this.onTimeout = onTimeout;
    this.arm();
  }

  pause(): void {
    if (this.done || this.paused++ > 0) return;
    clearTimeout(this.timer);
    this.left -= Date.now() - this.since;
  }

  resume(): void {
    if (this.done || --this.paused > 0) return;
    this.arm();
  }

  stop(): void {
    this.done = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    this.since = Date.now();
    this.timer = setTimeout(() => { this.done = true; this.onTimeout(); }, Math.max(0, this.left));
    this.timer.unref?.();
  }
}
