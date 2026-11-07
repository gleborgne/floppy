// Un cerveau qui se tait trop longtemps (modèle figé, réseau coupé) ne bloque pas le tour : il échoue, et Floppy le dit.
// Le délai compte le silence entre deux événements, pas la durée du tour (une délégation longue qui parle reste permise).
import { T, TextError } from "@floppy/core";

/**
 * Rend les événements de `src`. Si aucun n'arrive pendant `ms`, `stall` est arrêté (le cerveau est prévenu)
 * et l'itération échoue avec une erreur claire.
 */
export async function* withIdleTimeout<E>(src: AsyncIterable<E>, ms: number, stall: AbortController): AsyncGenerator<E> {
  const it = src[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const next = it.next();
      next.catch(() => {}); // abandonné après le délai : son rejet tardif n'est plus suivi
      const r = await Promise.race([
        next,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const s = Math.round(ms / 1000);
            stall.abort();
            reject(new TextError(T(`le cerveau ne répond plus depuis ${s} s`, `the brain hasn't answered for ${s} s`)));
          }, ms);
        }),
      ]).finally(() => clearTimeout(timer));
      if (r.done) return;
      yield r.value;
    }
  } finally {
    if (stall.signal.aborted) void it.return?.(undefined)?.catch?.(() => {});
  }
}
