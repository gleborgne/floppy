// Catalogue partagé des cerveaux CLI : rafraîchissement sans bloquer les réglages ni perdre les choix gardés.
import { T, type Context, type OpResult, type Text } from "@floppy/core";

export interface AgentModel { id: string; label: string }

export function createModelCatalog(ctx: Context, initial: AgentModel[], selected: () => AgentModel[], discover: () => Promise<AgentModel[]>) {
  const models = [...initial];
  const options: { value: string; label: string }[] = [];
  let inFlight: Promise<OpResult> | undefined;
  let nextRefresh = 0;
  let warning: Text | undefined;
  const sync = () => {
    for (const m of selected()) if (!models.some((x) => x.id === m.id)) models.push(m);
    options.splice(0, options.length, ...models.map((m) => ({ value: m.id, label: m.label })));
  };
  // selected peut lire le catalogue : appelé après que l'appelant l'a reçu.
  options.push(...models.map((m) => ({ value: m.id, label: m.label })));
  const refresh = (): Promise<OpResult> => {
    if (inFlight) return inFlight;
    if (!ctx.alive) return Promise.resolve({ ok: false, text: T("Plugin arrêté.", "Plugin stopped.") });
    inFlight = (async () => {
      try {
        const fresh = await Promise.resolve().then(discover);
        if (!fresh.length) throw new Error("catalogue vide");
        if (!ctx.alive) return { ok: false, text: T("Plugin arrêté.", "Plugin stopped.") };
        // Les modèles configurés et sélectionnés restent disponibles (alias et modèles privés compris).
        const merged = new Map([...fresh, ...initial, ...selected()].map((m) => [m.id, m]));
        for (const m of fresh) merged.set(m.id, m);
        models.splice(0, models.length, ...merged.values());
        sync();
        warning = undefined;
        return { ok: true, text: T("Liste des modèles actualisée.", "Model list refreshed.") };
      } catch {
        warning = T("Impossible d’actualiser les modèles. Les derniers choix sont conservés ; vérifie la connexion du programme et réessaie.",
          "Could not refresh models. Previous choices were kept; check the program’s connection and try again.");
        return { ok: false, text: warning };
      } finally {
        nextRefresh = Date.now() + 5 * 60_000;
        inFlight = undefined;
        if (ctx.alive) ctx.items.changed();
      }
    })();
    return inFlight;
  };
  return {
    models, options, refresh,
    find: (id: string) => models.find((m) => m.id === id),
    touch(load = true) { sync(); if (load && !inFlight && Date.now() >= nextRefresh && ctx.alive) void refresh(); },
    get warning() { return warning; },
    actions: [{ id: "refresh-models", label: T("Actualiser les modèles", "Refresh models") }],
  };
}
