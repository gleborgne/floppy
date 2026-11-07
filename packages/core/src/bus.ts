// Bus d'événements du noyau. Les plugins s'abonnent par ctx.on (désabonnement automatique au déchargement).
import type { ApprovalRequest, DecisionReason } from "./approval.ts";

export interface CoreEvents {
  /** Demande d'accord à montrer sur les corps. */
  "approval.request": ApprovalRequest;
  /** Demande fermée (réponse, délai, annulation) : les corps retirent la carte. */
  "approval.closed": { id: string; ok: boolean; reason: DecisionReason; by?: string };
  /**
   * Initiative : l'assistant a quelque chose à dire de lui-même (un job Orca fini, un rappel…).
   * important = dit à voix haute dès que possible (pas pendant un tour, pas en veille) + carte ;
   * normal = carte / notification seulement. `key` évite les doublons.
   */
  "initiative": { source: string; text: string; importance: "important" | "normal"; key?: string };
  /** Une tâche a fini avec succès (après l'annonce). Pour les plugins qui envoient ou rangent les résultats. */
  "task.done": { key: string; label: import("./i18n.ts").Text; raison: string; result: import("./services.ts").TaskResult };
  /** Changement d'état d'une entrée de la config. */
  "plugin.state": { id: string; plugin: string; state: PluginState; error?: string; missing?: string[] };
  /** Un service a un nouveau fournisseur (ou n'en a plus : provider = undefined). */
  "service.changed": { name: string; provider?: string };
  /** Le noyau doit repartir de zéro (nouveau répertoire de travail) : l'hôte le relance. Émis par le noyau seulement. */
  "floppy.restart": { reason: import("./i18n.ts").Text };
  [event: string]: unknown;
}

export type PluginState = "loaded" | "waiting" | "starting" | "active" | "stopping" | "error" | "disabled";

type Listener = (payload: any) => unknown;

export class Bus {
  private listeners = new Map<string, Set<Listener>>();

  on<K extends keyof CoreEvents & string>(event: K, fn: (payload: CoreEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  emit<K extends keyof CoreEvents & string>(event: K, payload: CoreEvents[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      const fail = (e: unknown) => console.error(`[bus] ${event} :`, e);
      try {
        // Un abonné qui plante (ou dont la promesse est rejetée) ne doit pas casser les autres ni le processus.
        const r: unknown = fn(payload);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, fail);
      } catch (e) {
        fail(e);
      }
    }
  }
}
