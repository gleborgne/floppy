// Réglages de choix posés par le noyau d'après les manifestes : `slot.<id>` (l'élément en service pour un rôle,
// ex. le cerveau). Changer un choix passe par la file du noyau ; un nouveau choix qui ne démarre pas rend l'ancien
// (jamais Floppy sans cerveau ni voix). Un slot est la seule façon de choisir ; le fournisseur d'un service sans slot
// vient de `services:` dans la config, sinon de la première entrée active (Kernel.providerOf).
import type { PluginDef } from "./manifest.ts";
import { T, TextError } from "../i18n.ts";
import type { KernelInternals } from "./kernel-internals.ts";

/** Slots du manifeste : un réglage `slot.<id>` par slot (fenêtre, voix, CLI). Le premier plugin qui déclare un id le garde. */
export function declareSlots(k: KernelInternals, def: PluginDef<any>): void {
  for (const slot of def.manifest.slots ?? []) {
    const cur = k.slotDefs.get(slot.id);
    if (cur) {
      if (cur.owner === def.manifest.id) cur.def = slot;
      else k.log("warn", def.manifest.id, `slot ${slot.id} déjà déclaré par ${cur.owner}`);
      continue;
    }
    const holder = { def: slot, owner: def.manifest.id };
    k.slotDefs.set(slot.id, holder);
    const kernel = k;
    const key = `slot.${slot.id}`;
    k.settings.declare("core", [{
      key, section: slot.section, label: slot.label, role: slot.id, type: "enum", risk: "free",
      description: slot.description ?? { fr: "L'élément en service pour ce rôle. Le noyau démarre le nouveau et arrête l'ancien.", en: "The item in use for this role. The kernel starts the new one and stops the old one." },
      riskFor: (v) => (kernel.slotOptions(holder.def).find((o) => o.value === v)?.cloud ? "ask" : "free"),
      get options() { return kernel.slotOptions(holder.def); },
      get: () => kernel.slotValue(slot.id),
      set: async (v) => {
        const value = String(v);
        if (!kernel.slotOptions(holder.def).some((o) => o.value === value)) throw new TextError(T("Choix inconnu ou désactivé", "Unknown or disabled choice"));
        // L'élément choisi avant charge encore (un gros modèle) : on l'annule, le nouveau choix n'attend pas sa fin.
        const loading = kernel.slotKey(slot.id);
        const old = loading ? kernel.forks.get(loading) : undefined;
        if (old?.state === "starting" && kernel.slotValue(slot.id) !== value) {
          kernel.abortStart(old, T("remplacé par un autre choix", "replaced by another choice"), { cancelled: true });
        }
        await kernel.enqueue(async () => {
          const before = kernel.selectionEdits.get(key);
          const restore = async () => {
            if (before === undefined) kernel.selectionEdits.delete(key); else kernel.selectionEdits.set(key, before);
            // L'ancien élément a pu être annulé pendant son chargement : il repart.
            const back = kernel.slotKey(slot.id);
            if (back && kernel.forks.get(back)?.cancelled) kernel.forks.delete(back);
            await kernel.reconcile();
          };
          kernel.selectionEdits.set(key, value);
          // Un élément en panne est réessayé quand on le choisit de nouveau.
          const target = kernel.slotKey(slot.id);
          if (target && kernel.forks.get(target)?.state === "error") kernel.forks.delete(target);
          try { await kernel.reconcile(); } catch (e) { await restore(); throw e; }
          const f = target ? kernel.forks.get(target) : undefined;
          if (f?.state === "error") {
            const why = f.error ?? T("démarrage impossible", "could not start");
            await restore(); // on revient à l'ancien choix : jamais laisser Floppy sans cerveau ni voix
            throw new TextError(why);
          }
        });
      },
    }]);
  }
}
