// Formes des données venues du noyau (via le processus principal) pour la fenêtre des réglages.
// Le noyau ne partage pas ces types : ce sont les champs que la fenêtre lit (le reste est ignoré).

/** Texte simple, ou { fr, en } venu du noyau. */
type KText = string | { fr?: string; en?: string } | null | undefined;

// ---- Réglages et rubriques
interface SettingsSection {
  id: string; label: KText; description?: KText; order?: number; icon?: string; parent?: string; merge?: boolean; view?: string;
}
interface SettingOption { value: string; label: KText; cloud?: boolean; note?: KText }
interface SettingInfo {
  key: string; section: string; group?: KText; label: KText; description?: KText;
  type: "enum" | "boolean" | "number" | "text" | (string & {});
  value: unknown; role?: string; options?: SettingOption[]; min?: number; max?: number; maxLength?: number; folder?: boolean;
  presets?: { value: string | number; label: KText }[]; risk?: string;
}
interface SettingsPlugin { id: string; plugin: string; state: string; fork?: { parent: string; service: string; item: string }; provides?: string[]; error?: KText; missing?: string[] }
/** Slot : un choix d'élément fait par le noyau (cerveau principal, voix…). */
interface SettingsSlot {
  id: string; service: string; section: string; owner?: string; label: KText; value: string; state: string;
  none?: KText; description?: KText; display?: string; step?: number; error?: KText;
}
interface SettingsSnapshot {
  lang?: string; sections?: SettingsSection[]; list?: SettingInfo[]; plugins?: SettingsPlugin[]; slots?: SettingsSlot[];
}
/** Réponse du noyau à un changement de réglage ou à « annuler ». */
interface SettingsReply { ok?: boolean; text?: string }
/** « Ouvre les réglages d'Orca » : la page d'un élément à montrer. */
interface SettingsFocusTarget { section: string; provider: string; id: string }

// ---- Éléments du catalogue (modèles, voix, connecteurs, corps, avatars)
interface FormField {
  key: string; label: KText; type: string; required?: boolean; default?: unknown; hint?: KText; placeholder?: KText; advanced?: boolean;
  showIf?: { key: string; values?: unknown[] }; options?: SettingOption[]; min?: number; max?: number; directory?: boolean;
  filters?: unknown[]; textKey?: string; prompts?: KText[]; seconds?: { min: number; max: number };
}
interface ItemKind {
  id: string; label: KText; description?: KText; cloud?: boolean; provides?: string[]; fields: FormField[];
}
interface ItemAction { id: string; label: KText; play?: boolean }
interface ItemChild { id: string; label: KText; detail?: KText; enabled?: boolean; tag?: KText; tone?: string }
interface ItemGroup { id: string; label: KText; detail?: KText }
interface ProviderItem {
  preview?: string;
  id: string; label: KText; detail?: KText; enabled?: boolean; active?: boolean; status?: string; statusText?: KText; progress?: number;
  kind?: string; values?: Record<string, unknown>; toggleable?: boolean; removable?: boolean; editable?: boolean; cloud?: boolean;
  group?: ItemGroup; actions?: ItemAction[]; tags?: KText[]; children?: ItemChild[]; childrenLabel?: KText; section?: string;
  settings?: string[]; logo?: string;
}
interface ProviderCaps {
  add?: boolean; update?: boolean; remove?: boolean; enable?: boolean; child?: boolean; test?: boolean; action?: boolean; search?: boolean;
}
interface ItemProvider {
  id: string; source?: string; offers?: string | string[]; section: string; label: KText; description?: KText; badge?: KText; order?: number;
  layout?: string; kinds: ItemKind[]; can: ProviderCaps; items: ProviderItem[]; searchHint?: KText; addLabel?: KText;
  childrenLabel?: KText; capabilities?: string[]; error?: KText;
}
interface ItemsSnapshot { lang?: string; providers?: ItemProvider[] }
/** Demande d'opération sur un élément (ajouter, tester, activer, retirer, action, recherche…). */
interface ItemOp {
  op: string; provider: string; id?: string; kind?: string; values?: Record<string, unknown>; action?: string; child?: string;
  on?: boolean; query?: string;
}
interface ItemOpResult { ok: boolean; text?: string; audio?: string; items?: ProviderItem[]; children?: ItemChild[] }
