// Outils internes du cerveau pour le catalogue : lister et activer / désactiver des éléments à la voix
// (« Floppy, désactive Qwen », « coupe le connecteur Azure DevOps »). Ajouter, modifier ou supprimer : jamais
// à la voix (contrôlé par CatalogRegistry.run).
import type { ToolDef } from "./tools.ts";
import type { CatalogRegistry } from "./catalog.ts";
import { T, tr } from "./i18n.ts";

/** Le refus de l'utilisateur (le texte est déjà dans la langue de l'assistant). */
export const isRefusal = (text: string): boolean => /^(Refusé|Refused)(\s|:|\.|$)/.test(text);

/** Les rubriques viennent du registre (plugins chargés) : l'outil est redéclaré quand la liste change (voir kernel). */
export function catalogTools(cat: CatalogRegistry): ToolDef[] {
  const sections = cat.sections();
  const rubrique = { type: "string", enum: sections };
  return [
    {
      name: "lister_elements",
      description: "Liste les éléments de l'assistant (modèles du cerveau, voix, connecteurs, corps, avatars), actifs ou désactivés. rubrique : " + (sections.join(", ") || "aucune") + " (facultatif).",
      inputSchema: { type: "object", properties: { rubrique } },
      level: "read",
      handler: async (a) => {
        const snap = await cat.snapshot();
        const want = typeof a.rubrique === "string" ? a.rubrique : undefined;
        const lines: { fr: string; en: string }[] = [];
        for (const p of snap) {
          if (want && p.section !== want) continue;
          if (!p.items.length) continue;
          lines.push(T(`${tr(p.label, "fr")} (${p.section}) :`, `${tr(p.label, "en")} (${p.section}):`));
          for (const i of p.items) {
            lines.push(T(`- ${tr(i.label, "fr")}${i.active ? " [en service]" : ""}${i.enabled ? "" : " [désactivé]"}`,
              `- ${tr(i.label, "en")}${i.active ? " [in use]" : ""}${i.enabled ? "" : " [disabled]"}`));
          }
        }
        if (!lines.length) return { status: "done", text: T("Aucun élément.", "No items.") };
        return { status: "done", text: T(lines.map((l) => l.fr).join("\n"), lines.map((l) => l.en).join("\n")) };
      },
    },
    {
      name: "activer_element",
      description: "Active ou désactive un élément (modèle, voix, connecteur, corps, avatar) quand l'utilisateur le demande. Désactivé = Floppy ne le voit plus, mais il n'est pas supprimé. Appelle-le tout de suite, sans confirmation. nom : le nom dit par l'utilisateur. actif : true pour activer, false pour désactiver.",
      inputSchema: {
        type: "object",
        properties: { nom: { type: "string" }, actif: { type: "boolean" }, rubrique },
        required: ["nom", "actif"],
      },
      level: "write",
      selfApproved: true,
      handler: async (a, meta) => {
        const hits = await cat.find(String(a.nom ?? ""), typeof a.rubrique === "string" ? a.rubrique : undefined);
        if (!hits.length) return { status: "failed", text: T(`Je ne trouve pas « ${String(a.nom)} ». Utilise lister_elements.`, `I can't find "${String(a.nom)}". Use lister_elements.`) };
        if (hits.length > 1) return { status: "failed", text: T(`Plusieurs éléments correspondent : ${hits.map((h) => tr(h.item.label, "fr")).join(", ")}. Demande lequel.`, `Several items match: ${hits.map((h) => tr(h.item.label, "en")).join(", ")}. Ask which one.`) };
        const { provider, item } = hits[0]!;
        const on = a.actif === true || a.actif === "true";
        const r = await cat.run({ op: "enable", provider, id: item.id, on }, "voice", meta.origin);
        const text = r.ok && !r.text ? T(`${tr(item.label, "fr")} : ${on ? "activé" : "désactivé"}.`, `${tr(item.label, "en")}: ${on ? "on" : "off"}.`) : r.text;
        return { status: r.ok ? "done" : isRefusal(r.text) ? "refused" : "failed", text };
      },
    },
  ];
}
