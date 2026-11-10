import type { ToolCallInput, ToolResult } from "../tools.ts";

// Hooks en cascade : des middlewares avec next(), appelés dans l'ordre d'enregistrement.
// Exemple : `tool.before` (règles → accord → journal) avant chaque appel d'outil.
// Un middleware qui plante AVANT next() arrête la chaîne : l'erreur remonte (un contrôle qui refuse en levant une
// erreur bloque l'action). Un middleware qui plante APRÈS next() réussi est signalé, et le résultat de la suite est gardé.

export type Next<I, O> = (input: I) => Promise<O>;
export type Middleware<I, O> = (input: I, next: Next<I, O>) => Promise<O>;

/**
 * Registre des hooks : nom -> { input, output }. Le propriétaire du hook (celui qui le lance) le déclare, au même endroit
 * que ses types, par augmentation de module (comme `Services`) :
 *   declare module "@floppy/core" { interface HookTypes { "mon.hook": { input: MonEntree; output: MaSortie } } }
 * Le noyau n'a que le sien (`tool.before`) ; les autres vivent dans @floppy/contracts, par domaine.
 */
export interface HookTypes {
  /** Avant chaque appel d'outil (règles -> accord -> journal) ; la fin de chaîne exécute l'outil. */
  "tool.before": { input: ToolCallInput; output: ToolResult };
}

/** Nom d'un hook connu. */
export type HookName = keyof HookTypes & string;
/** Ce que reçoit la chaîne du hook `K`. */
export type HookInput<K extends HookName> = HookTypes[K] extends { input: infer I } ? I : never;
/** Ce que rend la chaîne du hook `K`. */
export type HookOutput<K extends HookName> = HookTypes[K] extends { output: infer O } ? O : never;

interface Link { mw: Middleware<any, any>; owner?: string }

export class Hooks {
  private chains = new Map<string, Link[]>();
  /** Erreur d'un middleware (le noyau l'écrit au journal, au nom du plugin). */
  onError: (owner: string | undefined, name: string, err: unknown) => void = (owner, name, err) =>
    console.error(`[hooks] ${name}${owner ? ` (${owner})` : ""} :`, err);

  /** Ajoute un middleware. Retourne une fonction pour le retirer. */
  add<K extends HookName>(name: K, mw: Middleware<HookInput<K>, HookOutput<K>>, owner?: string): () => void {
    const link: Link = { mw, ...(owner ? { owner } : {}) };
    const list = this.chains.get(name) ?? [];
    list.push(link);
    this.chains.set(name, list);
    return () => {
      const cur = this.chains.get(name) ?? [];
      this.chains.set(name, cur.filter((l) => l !== link));
    };
  }

  count(name: HookName): number {
    return this.chains.get(name)?.length ?? 0;
  }

  /** Lance la chaîne. `final` est appelé si chaque middleware appelle next(). */
  run<K extends HookName>(name: K, input: HookInput<K>, final: Next<HookInput<K>, HookOutput<K>>): Promise<HookOutput<K>> {
    type I = HookInput<K>;
    type O = HookOutput<K>;
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
        throw err;
      });
    };
    return step(0, input);
  }
}
