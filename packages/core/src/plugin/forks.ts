// Forks : un élément offert (ctx.offer) qui tourne dans son propre contexte, clé "<entrée>/<service>/<élément>".
// Démarrage d'un fork (avec `max`), emprunt par l'hôte, relance, reprise après panne, emprunteurs prévenus.
// Lit la classe Kernel par sa vue interne (kernel-internals.ts) : la table `forks`, les compteurs de demande
// (`holds`) et les minuteries de reprise ont un seul propriétaire, le noyau. Le cycle de vie reste dans kernel.ts.
import { offerItems } from "./lifecycle-util.ts";
import type { Entry } from "./kernel.ts";
import type { KernelInternals } from "./kernel-internals.ts";

/** Démarre (si besoin) le fork d'un élément. Rend le fork s'il est actif. */
export async function ensureFork(k: KernelInternals, key: string): Promise<Entry | undefined> {
  const [parent = "", service = ""] = key.split("/", 2);
  const item = key.slice(parent.length + service.length + 2);
  const p = k.entries.get(parent);
  const offer = p?.state === "active" ? p.offers.get(service) : undefined;
  if (!p || !offer) return undefined;
  let f = k.forks.get(key);
  if (f?.state === "active") return f;
  if (f && f.state !== "loaded") return undefined; // en panne (choisir de nouveau pour réessayer), ou déjà en démarrage
  if (!f) {
    f = {
      cfg: { id: key, plugin: p.cfg.plugin, disabled: false }, def: p.def!, parsed: p.parsed, state: "loaded",
      provided: new Map(), bound: new Map(), used: new Set(), slotBound: new Map(), offers: new Map(), retries: 0,
      fork: { parent, service, item },
    };
    k.forks.set(key, f);
  }
  if (offer.max) {
    const others = [...k.forks.values()]
      .filter((x) => x !== f && x.fork!.parent === parent && x.fork!.service === service && x.state === "active")
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    while (others.length >= offer.max) {
      const old = others.shift()!;
      k.log("info", old.cfg.id, `place libérée pour ${item}`);
      await k.stopEntry(old, "loaded");
      k.forks.delete(old.cfg.id);
    }
  }
  await k.startEntry(f);
  return f.state === "active" ? f : undefined;
}

/**
 * Emprunte un élément offert (« <entrée>/<élément> ») pour l'hôte (ex. test de vitesse du premier lancement) :
 * le noyau le fait tourner jusqu'à release(). Undefined : élément absent ou en panne.
 */
export function borrowItem<T = unknown>(k: KernelInternals, service: string, value: string): Promise<{ service: T; release(): void } | undefined> {
  const cut = value.indexOf("/");
  if (cut < 1) return Promise.resolve(undefined);
  const entry = value.slice(0, cut);
  const item = value.slice(cut + 1);
  return k.enqueue(async () => {
    const p = k.entries.get(entry);
    const offer = p?.state === "active" ? p.offers.get(service) : undefined;
    if (!offer || !offerItems(offer).some((i) => i.id === item)) return undefined;
    const key = `${entry}/${service}/${item}`;
    k.hold(key, 1);
    const f = await k.ensureFork(key);
    const svc = f?.provided.get(service) as T | undefined;
    if (!svc) { k.hold(key, -1); await k.reconcile(); return undefined; }
    let done = false;
    return {
      service: svc,
      release: () => {
        if (done) return;
        done = true;
        k.hold(key, -1);
        void k.enqueue(() => k.reconcile()).catch(() => {});
      },
    };
  });
}

/** Relance les forks d'une entrée (nouveau programme) : ceux en marche repartent, ceux en panne sont réessayés. */
export function restartForks(k: KernelInternals, parent: string, service?: string): Promise<void> {
  return k.enqueue(async () => {
    const list = [...k.forks.entries()].filter(([, f]) => f.fork!.parent === parent && (!service || f.fork!.service === service));
    for (const [key, f] of list) {
      // Un fork en panne n'a rien fourni : ceux qui le voulaient (slot) tournent sans lui ; ils repartent pour le redemander.
      if (f.state === "error") {
        for (const y of [...k.all()]) if (y.state === "active" && [...y.slotBound.values()].includes(key)) await k.stopEntry(y, "loaded");
      }
      if (f.state !== "loaded") await k.stopEntry(f, "loaded");
      k.forks.delete(key);
    }
    if (list.length) await k.reconcile();
  });
}

/** Reprise d'un fork en panne (appelée par retryNow quand l'entrée est un fork). */
export async function retryFork(k: KernelInternals, e: Entry): Promise<void> {
  if (k.forks.get(e.cfg.id) !== e) return;
  // Ceux qui voulaient ce fork tournent sans lui : ils repartent pour le redemander (comme restartForks).
  for (const y of [...k.all()]) if (y.state === "active" && [...y.slotBound.values()].includes(e.cfg.id)) await k.stopEntry(y, "loaded");
  e.state = "loaded";
  delete e.error;
  k.emitState(e);
  await k.reconcile();
}

/** Prévient ceux qui ont emprunté ce fork : il s'est arrêté (panne, arrêt, nouveau choix). */
export function loseBorrowers(k: KernelInternals, key: string): void {
  const set = k.borrowers.get(key);
  if (!set) return;
  k.borrowers.delete(key);
  for (const fn of set) { try { fn(); } catch { /* rien */ } }
}
