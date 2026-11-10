// Slots : le choix d'un élément pour un rôle du manifeste (`manifest.slots`). Options offertes, valeur choisie,
// clé du fork choisi, état montré par la fenêtre des réglages. Lit la classe Kernel par sa vue interne
// (kernel-internals.ts) ; le réglage `slot.<id>` et le retour à l'ancien choix sont dans selection-settings.ts.
import type { SlotDef } from "./manifest.ts";
import type { SettingOption } from "../settings.ts";
import { tr, type Text } from "../i18n.ts";
import { offerItems } from "./lifecycle-util.ts";
import type { KernelInternals } from "./kernel-internals.ts";
import type { SlotStatus } from "./kernel.ts";

export function slotOptions(k: KernelInternals, slot: SlotDef): (SettingOption & { cloud?: boolean; note?: Text })[] {
  const out: (SettingOption & { cloud?: boolean; note?: Text })[] = slot.none ? [{ value: "@none", label: slot.none }] : [];
  for (const e of k.entries.values()) {
    const offer = e.state === "active" ? e.offers.get(slot.service) : undefined;
    if (!offer) continue;
    for (const i of offerItems(offer)) {
      out.push({
        value: `${e.cfg.id}/${i.id}`, label: i.label,
        ...(i.aliases?.length ? { aliases: i.aliases } : {}), ...(i.slow ? { slow: true } : {}), ...(i.cloud ? { cloud: true } : {}),
        ...(i.note ? { note: i.note } : {}),
      });
    }
  }
  return out;
}

/** Valeur d'un slot : le choix de l'utilisateur, sinon floppy.yml, sinon le premier élément (slot obligatoire) ou « aucun ». */
export function slotValue(k: KernelInternals, id: string): string {
  const key = `slot.${id}`;
  const v = k.selectionEdits.get(key) ?? k.settings.savedValue<string>(key) ?? k.slotDefaults[id];
  const slot = k.slotDefs.get(id)?.def;
  if (v) return slot ? followRename(k, slot, v) : v;
  if (!slot || (slot.none && !slot.defaultFirst)) return "@none";
  return slotOptions(k, slot).find((o) => o.value !== "@none")?.value ?? "@none";
}

/** Choix « <entrée>/<ancien id> » d'un élément renommé par son plugin (OfferDef.renamed) : rend le nouvel id. */
export function followRename(k: KernelInternals, slot: SlotDef, v: string): string {
  const cut = v.indexOf("/");
  if (cut < 1) return v;
  const p = k.entries.get(v.slice(0, cut));
  const to = (p?.state === "active" ? p.offers.get(slot.service) : undefined)?.renamed?.[v.slice(cut + 1)];
  return to ? `${v.slice(0, cut)}/${to}` : v;
}

/** Clé du fork choisi pour un slot ("<entrée>/<service>/<élément>"), si l'élément est offert en ce moment. */
export function slotKey(k: KernelInternals, id: string): string | undefined {
  const slot = k.slotDefs.get(id)?.def;
  if (!slot) return undefined;
  const v = slotValue(k, id);
  const cut = v.indexOf("/");
  if (v === "@none" || cut < 1) return undefined;
  const entry = v.slice(0, cut);
  const item = v.slice(cut + 1);
  const p = k.entries.get(entry);
  const offer = p?.state === "active" ? p.offers.get(slot.service) : undefined;
  if (!offer || !offerItems(offer).some((i) => i.id === item)) return undefined;
  return `${entry}/${slot.service}/${item}`;
}

/** Les slots, leur choix et l'état de l'élément choisi. */
export function slotStatuses(k: KernelInternals): SlotStatus[] {
  return [...k.slotDefs.values()].map(({ def, owner }) => {
    const key = slotKey(k, def.id);
    const f = key ? k.forks.get(key) : undefined;
    return {
      id: def.id, service: def.service, section: def.section, label: def.label, owner,
      ...(def.description ? { description: def.description } : {}), ...(def.none ? { none: def.none } : {}), ...(def.display ? { display: def.display } : {}),
      ...(def.step ? { step: def.step } : {}),
      value: slotValue(k, def.id),
      state: f ? f.state : key ? "idle" : "none",
      ...(f?.error ? { error: tr(f.error, k.uiLang) } : {}),
    };
  });
}
