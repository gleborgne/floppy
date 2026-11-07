// Surveillance d'un serveur local déjà prêt (llama-server, audio.cpp) : un serveur figé (il ne répond plus, sans
// s'arrêter) n'est vu par personne. Après plusieurs vérifications ratées d'affilée, onDead est appelé une fois ;
// le plugin appelle alors ctx.fail, et le noyau relance l'élément (reprise automatique).
import type { Context } from "../plugin/context.ts";

export interface HealthWatch {
  /** Vrai si le serveur répond. Doit finir vite (un délai court, ex. AbortSignal.timeout(5000)). */
  check(): Promise<boolean>;
  /** Le serveur ne répond plus. */
  onDead(misses: number): void;
  /** Intervalle entre deux vérifications (défaut : 30 s). */
  everyMs?: number;
  /** Vérifications ratées d'affilée avant onDead (défaut : 3). */
  misses?: number;
}

/** Lance la surveillance. Rend la fonction qui l'arrête (elle s'arrête aussi avec le plugin). */
export function watchHealth(ctx: Pick<Context, "effect">, w: HealthWatch): () => void {
  let missed = 0;
  let busy = false;
  let done = false;
  const timer = setInterval(() => {
    if (busy || done) return;
    busy = true;
    void w.check().catch(() => false).then((ok) => {
      busy = false;
      if (done) return;
      if (ok) { missed = 0; return; }
      if (++missed < (w.misses ?? 3)) return;
      stop();
      w.onDead(missed);
    });
  }, w.everyMs ?? 30_000);
  timer.unref?.();
  const off = ctx.effect(() => { done = true; clearInterval(timer); });
  const stop = () => { done = true; clearInterval(timer); void off(); };
  return stop;
}
