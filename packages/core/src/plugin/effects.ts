// Effets : tout ce qu'un plugin ouvre (processus, serveur, abonnement, minuterie) est enregistré ici
// avec sa fonction de fermeture. Décharger le plugin ferme tout, dans l'ordre inverse d'ouverture.

export type Disposer = () => void | Promise<void>;

export class EffectScope {
  private disposers: Disposer[] = [];
  private closed = false;

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

  /** Ferme tous les effets, du dernier au premier. Une erreur n'empêche pas de fermer les suivants. */
  async dispose(): Promise<Error[]> {
    this.closed = true;
    const errors: Error[] = [];
    for (const d of this.disposers.splice(0).reverse()) {
      try {
        await d();
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return errors;
  }
}
