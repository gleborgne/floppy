// Effets : tout ce qu'un plugin ouvre (processus, serveur, abonnement, minuterie) est enregistré ici
// avec sa fonction de fermeture. Décharger le plugin ferme tout, dans l'ordre inverse d'ouverture.

export type Disposer = () => void | Promise<void>;

/** Délai par défaut d'une fermeture : au-delà, elle est abandonnée (signalée) et les suivantes tournent. */
export const DISPOSE_TIMEOUT_MS = 10_000;

export class EffectScope {
  private disposers: Disposer[] = [];
  private closed = false;
  private markClosing!: () => void;
  /** Tenue dès que la fermeture commence (fin de apply, ctx.fail, arrêt) : un démarrage en cours cesse d'être attendu. */
  readonly closing: Promise<void> = new Promise((r) => { this.markClosing = r; });

  /** Enregistre une fermeture. Retourne une fonction pour fermer cet effet seul, plus tôt. */
  add(dispose: Disposer): () => Promise<void> {
    if (this.closed) {
      // Le plugin est déjà déchargé : on ferme tout de suite ce qu'il vient d'ouvrir trop tard.
      void Promise.resolve().then(dispose).catch(() => {});
      return async () => {};
    }
    let done = false;
    const once: Disposer = async () => {
      if (done) return;
      done = true;
      await dispose();
    };
    this.disposers.push(once);
    return async () => {
      this.disposers = this.disposers.filter((d) => d !== once);
      await once();
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.disposers.length;
  }

  /**
   * Ferme tous les effets, du dernier au premier. Une erreur n'empêche pas de fermer les suivants.
   * Une fermeture plus longue que `timeoutMs` est abandonnée (une erreur le dit) : un plugin bloqué ne bloque pas le noyau.
   */
  async dispose(opts: { timeoutMs?: number } = {}): Promise<Error[]> {
    this.closed = true;
    this.markClosing();
    const limit = opts.timeoutMs ?? DISPOSE_TIMEOUT_MS;
    const errors: Error[] = [];
    for (const d of this.disposers.splice(0).reverse()) {
      let timer: NodeJS.Timeout | undefined;
      const run = Promise.resolve().then(d);
      run.catch(() => {}); // abandonnée après le délai : son rejet tardif n'est plus suivi
      try {
        await Promise.race([
          run,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fermeture trop longue (${Math.round(limit / 1000)} s) : abandonnée`)), limit); }),
        ]);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      } finally {
        clearTimeout(timer);
      }
    }
    return errors;
  }
}
