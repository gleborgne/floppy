// Hooks en cascade : des middlewares avec next(), appelés dans l'ordre d'enregistrement.
// Exemple : `tool.before` (règles → accord → journal) avant chaque appel d'outil.

export type Next<I, O> = (input: I) => Promise<O>;
export type Middleware<I, O> = (input: I, next: Next<I, O>) => Promise<O>;

export class Hooks {
  private chains = new Map<string, Middleware<any, any>[]>();

  /** Ajoute un middleware. Retourne une fonction pour le retirer. */
  add<I, O>(name: string, mw: Middleware<I, O>): () => void {
    const list = this.chains.get(name) ?? [];
    list.push(mw);
    this.chains.set(name, list);
    return () => {
      const cur = this.chains.get(name) ?? [];
      this.chains.set(name, cur.filter((m) => m !== mw));
    };
  }

  count(name: string): number {
    return this.chains.get(name)?.length ?? 0;
  }

  /** Lance la chaîne. `final` est appelé si chaque middleware appelle next(). */
  run<I, O>(name: string, input: I, final: Next<I, O>): Promise<O> {
    const list = [...(this.chains.get(name) ?? [])] as Middleware<I, O>[];
    const step = (i: number, value: I): Promise<O> => {
      const mw = list[i];
      if (!mw) return final(value);
      let called = false;
      return mw(value, (v) => {
        if (called) return Promise.reject(new Error(`hook ${name} : next() appelé deux fois`));
        called = true;
        return step(i + 1, v);
      });
    };
    return step(0, input);
  }
}
