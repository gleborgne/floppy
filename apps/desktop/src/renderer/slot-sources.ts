// Les plugins qui peuvent remplir un slot, pour la fenêtre des réglages (fonction pure, testée sans fenêtre).
// Trois façons d'y être, toutes visibles : sinon un plugin installé disparaît de la rubrique.
// 1. un fournisseur d'éléments qui offre le service (ctx.items.declare avec `offers`, ex. audio.cpp) ;
// 2. un plugin installé (fournisseur « apps-… ») dont le type fournit le service, même éteint ;
// 3. une option du réglage du slot qu'aucun fournisseur ne montre (ctx.offer seul, ex. Voix du système).

/** Une ligne par entrée (plugin) : ses fournisseurs d'éléments et ses options sans fournisseur. */
export interface SlotSource { source: string; provs: ItemProvider[]; options: SettingOption[] }

export const offersOf = (p: { offers?: string | string[] }): string[] => (Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : []);
export const entryOf = (v: string | undefined): string => (v && v !== "@none" ? v.slice(0, v.indexOf("/")) : "@none");

/**
 * providers : fournisseurs d'éléments du catalogue ; options : options du réglage du slot ; service : service du slot
 * (ex. « tts »). Une ligne par entrée, dans l'ordre d'apparition.
 */
export function slotSources(providers: ItemProvider[], options: SettingOption[] | undefined, service: string): SlotSource[] {
  const m = new Map<string, SlotSource>();
  const get = (source: string): SlotSource => {
    let s = m.get(source);
    if (!s) { s = { source, provs: [], options: [] }; m.set(source, s); }
    return s;
  };
  for (const p of providers) if (offersOf(p).includes(service)) get(p.source ?? "").provs.push(p);
  for (const p of providers) {
    if (!p.id.startsWith("apps-")) continue;
    for (const it of p.items) if ((p.kinds ?? []).find((k) => k.id === it.kind)?.provides?.includes(service)) get(it.id);
  }
  const shown = new Set<string>();
  for (const { source, provs } of m.values()) for (const p of provs) for (const it of p.items) shown.add(`${source}/${it.id}`);
  for (const o of options ?? []) {
    if (o.value === "@none" || shown.has(o.value)) continue;
    get(entryOf(o.value)).options.push(o);
  }
  return [...m.values()];
}
