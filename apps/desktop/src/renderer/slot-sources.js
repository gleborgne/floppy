// Les plugins qui peuvent remplir un slot, pour la fenêtre des réglages (fonction pure, testée sans fenêtre).
// Trois façons d'y être, toutes visibles : sinon un plugin installé disparaît de la rubrique.
// 1. un fournisseur d'éléments qui offre le service (ctx.items.declare avec `offers`, ex. audio.cpp) ;
// 2. un plugin installé (fournisseur « apps-… ») dont le type fournit le service, même éteint ;
// 3. une option du réglage du slot qu'aucun fournisseur ne montre (ctx.offer seul, ex. Voix du système).

export const offersOf = (p) => (Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : []);
export const entryOf = (v) => (v && v !== "@none" ? v.slice(0, v.indexOf("/")) : "@none");

/**
 * @param {any[]} providers fournisseurs d'éléments du catalogue
 * @param {{ value: string }[]} options options du réglage du slot
 * @param {string} service service du slot (ex. « tts »)
 * @returns {{ source: string, provs: any[], options: any[] }[]} une ligne par entrée, dans l'ordre d'apparition
 */
export function slotSources(providers, options, service) {
  const m = new Map();
  const get = (source) => {
    if (!m.has(source)) m.set(source, { source, provs: [], options: [] });
    return m.get(source);
  };
  for (const p of providers) if (offersOf(p).includes(service)) get(p.source).provs.push(p);
  for (const p of providers) {
    if (!p.id.startsWith("apps-")) continue;
    for (const it of p.items) if ((p.kinds ?? []).find((k) => k.id === it.kind)?.provides?.includes(service)) get(it.id);
  }
  const shown = new Set();
  for (const { source, provs } of m.values()) for (const p of provs) for (const it of p.items) shown.add(`${source}/${it.id}`);
  for (const o of options ?? []) {
    if (o.value === "@none" || shown.has(o.value)) continue;
    get(entryOf(o.value)).options.push(o);
  }
  return [...m.values()];
}
