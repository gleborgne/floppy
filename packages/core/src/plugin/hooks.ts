// Hooks en cascade : des middlewares avec next(), appelés dans l'ordre d'enregistrement.
// Exemple : `tool.before` (règles → accord → journal) avant chaque appel d'outil.
// Un middleware qui plante est sauté (et signalé) : la chaîne continue comme s'il avait appelé next().

export type Next<I, O> = (input: I) => Promise<O>;
export type Middleware<I, O> = (input: I, next: Next<I, O>) => Promise<O>;

interface Link { mw: Middleware<any, any>; owner?: string }

export class Hooks {
  private chains = new Map<string, Link[]>();
  /** Erreur d'un middleware (le noyau l'écrit au journal, au nom du plugin). */
  onError: (owner: string | undefined, name: string, err: unknown) => void = (owner, name, err) =>
    console.error(`[hooks] ${name}${owner ? ` (${owner})` : ""} :`, err);

  /** Ajoute un middleware. Retourne une fonction pour le retirer. */
  add<I, O>(name: string, mw: Middleware<I, O>, owner?: string): () => void {
    const link: Link = { mw, ...(owner ? { owner } : {}) };
    const list = this.chains.get(name) ?? [];
    list.push(link);
    this.chains.set(name, list);
    return () => {
      const cur = this.chains.get(name) ?? [];
      this.chains.set(name, cur.filter((l) => l !== link));
    };
  }

  count(name: string): number {
    return this.chains.get(name)?.length ?? 0;
  }

  /** Lance la chaîne. `final` est appelé si chaque middleware appelle next(). */
  run<I, O>(name: string, input: I, final: Next<I, O>): Promise<O> {
    const list = [...(this.chains.get(name) ?? [])];
    const step = (i: number, value: I): Promise<O> => {
      const link = list[i];
      if (!link) return final(value);
      let called = false;
      let downstream: Promise<O> | undefined;
      const next: Next<I, O> = (v) => {
        if (called) return Promise.reject(new Error(`hook ${name} : next() appelé deux fois`));
        called = true;
        downstream = step(i + 1, v);
        return downstream;
      };
      let mine: Promise<O>;
      try { mine = Promise.resolve((link.mw as Middleware<I, O>)(value, next)); } catch (err) { mine = Promise.reject(err); }
      return mine.catch((err: unknown) => {
        // La suite de la chaîne a échoué (un autre middleware, l'outil) : l'erreur remonte telle quelle.
        // Elle a réussi, puis ce middleware a planté : on le signale et on garde le résultat de la suite.
        if (downstream) return downstream.then((v) => { this.onError(link.owner, name, err); return v; }, () => { throw err; });
        this.onError(link.owner, name, err);
        return step(i + 1, value);
      });
    };
    return step(0, input);
  }
}
