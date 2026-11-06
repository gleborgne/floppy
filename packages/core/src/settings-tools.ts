// Outils internes du cerveau pour les réglages. Le contrôle du risque est fait par SettingsRegistry.change.
import type { ToolDef } from "./tools.ts";
import type { SettingsRegistry, SettingInfo } from "./settings.ts";
import { T, tr } from "./i18n.ts";
import { isRefusal } from "./catalog-tools.ts";

function describe(s: SettingInfo, labelOf: (v: unknown) => string): string {
  const choices = s.type === "enum" ? ` (choix : ${(s.options ?? []).map((o) => tr(o.label)).join(", ")})`
    : s.type === "number" ? ` (de ${s.min} à ${s.max})`
    : s.type === "text" ? ` (texte libre${s.presets?.length ? `, ou : ${s.presets.map((o) => tr(o.label)).join(", ")}` : ""})` : " (oui / non)";
  const risk = s.risk === "free" ? "" : s.risk === "ask" ? " [demande l'accord]" : " [pas à la voix]";
  return `- ${s.key} : ${tr(s.label)}, actuellement « ${labelOf(s.value)} »${choices}${risk}`;
}

export function settingsTools(reg: SettingsRegistry): ToolDef[] {
  const list = reg.list();
  const lines = list.map((s) => describe(s, (v) => (s.type === "enum" ? tr(s.options?.find((o) => o.value === v)?.label) || String(v) : s.type === "boolean" ? (v ? "oui" : "non") : s.type === "text" ? tr(s.presets?.find((o) => o.value === v)?.label) || String(v) : String(v))));
  const keys = list.map((s) => s.key).join(", ") || "aucun";
  return [
    {
      name: "lister_reglages",
      description: "Liste tes réglages (voix, écoute, délégation…) avec leur valeur actuelle et les choix possibles.",
      inputSchema: { type: "object", properties: {} },
      level: "read",
      handler: async () => ({ status: "done", text: lines.join("\n") || "Aucun réglage." }),
    },
    {
      name: "changer_reglage",
      description: `Change un de tes réglages quand l'utilisateur le demande (« prends une voix de femme », « change de voix », « écoute plus longtemps »). Appelle-le tout de suite, sans rien dire avant et sans demander de confirmation : l'utilisateur peut dire « annule ». S'il ne précise pas la valeur, choisis-en une toi-même, différente de l'actuelle. cle : ${keys}. valeur : le choix, en clair. Réglages :\n${lines.join("\n")}\nLes droits d'accès (dossiers, comptes) ne se règlent jamais à la voix.`,
      inputSchema: { type: "object", properties: { cle: { type: "string", enum: list.map((s) => s.key) }, valeur: { type: "string" } }, required: ["cle", "valeur"] },
      level: "write",
      selfApproved: true,
      handler: async (a, meta) => {
        const r = await reg.change(String(a.cle ?? ""), a.valeur, "voice", meta.origin);
        return { status: r.ok ? "done" : isRefusal(r.text) ? "refused" : "failed", text: r.text };
      },
    },
    {
      name: "annuler_reglage",
      description: "Annule le dernier changement de réglage (« annule », « remets comme avant »).",
      inputSchema: { type: "object", properties: {} },
      level: "write",
      selfApproved: true,
      handler: async (_a, meta) => { const r = await reg.undo("voice", meta.origin); return { status: r.ok ? "done" : "failed", text: r.text }; },
    },
  ];
}
