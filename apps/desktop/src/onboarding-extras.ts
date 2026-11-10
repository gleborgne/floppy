// Ce que la fenêtre « Bienvenue » lit en plus du plan : façons d'appeler Floppy, connecteurs, aperçu de l'avatar.
// Fonctions pures (testées à part) ; kernel.ts les branche sur les réglages et le catalogue du noyau.
import type { ProviderSnapshot, SettingInfo } from "@floppy/core";

/** Réglages que la fenêtre peut changer, par « façon » : les mêmes que dans les Réglages (aucun chemin à part). */
export const WAY_KEYS = { wake: "slot.listen.wakeword", talk: "raccourci_parler" } as const;
/** Valeur du slot « mot d'activation » quand il est éteint. */
export const NO_WAKE = "@none";
/** Fournisseur des connecteurs (rubrique « connecteurs » : navigateur, recherche, courrier…). */
export const TOOLS_PROVIDER = "apps-connecteurs";

export interface Ways {
  wake: { on: boolean; value: string; fallback: string } | null;
  talk: { keys: string; fallback: string } | null;
}

/**
 * Façons d'appeler Floppy lues dans les réglages. `wake.fallback` : la valeur qui rallume le mot d'activation (la valeur
 * actuelle si elle est allumée, sinon la première option qui n'est pas « éteint »). Réglage absent : null.
 */
export function waysOf(settings: SettingInfo[]): Ways {
  const wake = settings.find((s) => s.key === WAY_KEYS.wake);
  const talk = settings.find((s) => s.key === WAY_KEYS.talk);
  const on = (v: unknown) => typeof v === "string" && v !== "" && v !== NO_WAKE;
  const wakeFallback = wake ? (on(wake.value) ? String(wake.value) : wake.options?.find((o) => on(o.value))?.value) : undefined;
  const preset = talk?.presets?.[0]?.value;
  return {
    wake: wake && wakeFallback ? { on: on(wake.value), value: String(wake.value ?? ""), fallback: wakeFallback } : null,
    talk: talk ? { keys: typeof talk.value === "string" ? talk.value : "", fallback: typeof preset === "string" ? preset : "" } : null,
  };
}

/** Le changement demandé par la fenêtre : clé de réglage et valeur, ou undefined si la demande n'est pas permise. */
export function wayChange(way: unknown, value: unknown): { key: string; value: string } | undefined {
  if (way !== "wake" && way !== "talk") return undefined;
  return { key: WAY_KEYS[way], value: typeof value === "string" ? value.slice(0, 200) : "" };
}

export interface ToolRow { id: string; label: unknown; detail?: unknown; enabled: boolean; toggleable: boolean }

/** Connecteurs ajoutés à Floppy : ce que la fenêtre peut allumer ou éteindre (même opération « enable » que les Réglages). */
export function toolsOf(providers: ProviderSnapshot[]): { provider: string; items: ToolRow[] } {
  const p = providers.find((x) => x.id === TOOLS_PROVIDER);
  if (!p) return { provider: TOOLS_PROVIDER, items: [] };
  return {
    provider: p.id,
    items: p.items.map((it) => ({
      id: it.id, label: it.label, ...(it.detail ? { detail: it.detail } : {}), enabled: it.enabled, toggleable: p.can.enable && it.toggleable !== false,
    })),
  };
}

/** Aperçu de l'avatar affiché (adresse data:image/…) : celui en service, sinon le premier qui en a un. */
export function avatarPreviewOf(providers: ProviderSnapshot[]): string | undefined {
  const items = providers.find((x) => x.id === "avatars")?.items ?? [];
  const ok = (p: unknown): p is string => typeof p === "string" && p.startsWith("data:image/");
  const pick = items.find((i) => i.active && ok(i.preview)) ?? items.find((i) => ok(i.preview));
  return pick?.preview;
}
