// Outils internes du cerveau pour le catalogue : lister et activer / désactiver des éléments à la voix
// (« Floppy, désactive Qwen », « coupe le connecteur Azure DevOps »), et ajouter une application livrée avec Floppy
// (« tu sais te connecter à Orca ? » → « alors installe-le »), toujours après un accord. Ajouter un autre élément
// (MCP…), modifier ou supprimer : jamais à la voix (contrôlé par CatalogRegistry.run).
import type { ToolDef } from "./tools.ts";
import type { CatalogRegistry } from "./catalog.ts";
import { T, tr } from "./i18n.ts";

/** Le refus de l'utilisateur (le texte est déjà dans la langue de l'assistant). */
export const isRefusal = (text: string): boolean => /^(Refusé|Refused)(\s|:|\.|$)/.test(text);

/** Les rubriques viennent du registre (plugins chargés) : l'outil est redéclaré quand la liste change (voir kernel). */
export function catalogTools(cat: CatalogRegistry): ToolDef[] {
  const sections = cat.sections();
  const section = { type: "string", enum: sections };
  return [
    {
      name: "list_items",
      description: "Liste les éléments de l'assistant (modèles du cerveau, voix, connecteurs, corps, avatars), actifs ou désactivés, et les applications qu'on peut encore ajouter (« sais-tu te connecter à … ? »). section : " + (sections.join(", ") || "aucune") + " (facultatif).",
      inputSchema: { type: "object", properties: { section } },
      level: "read",
      handler: async (a) => {
        const snap = await cat.snapshot();
        const want = typeof a.section === "string" ? a.section : undefined;
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
        // Applications qu'on peut ajouter (add_app). Celles déjà là, si une seule est permise, sont dans la liste au-dessus.
        for (const p of snap) {
          if (want && p.section !== want) continue;
          if (!cat.provider(p.id)?.voiceAdd) continue;
          const added = new Set(p.items.map((i) => i.kind));
          const free = p.kinds.filter((k) => !(k.single && added.has(k.id)));
          if (!free.length) continue;
          lines.push(T(`À ajouter (${p.section}, avec add_app) :`, `Can be added (${p.section}, with add_app):`));
          for (const k of free) {
            const d = k.description ? [` : ${tr(k.description, "fr")}`, `: ${tr(k.description, "en")}`] : ["", ""];
            lines.push(T(`- ${tr(k.label, "fr")}${k.cloud ? " [cloud]" : ""}${d[0]}`, `- ${tr(k.label, "en")}${k.cloud ? " [cloud]" : ""}${d[1]}`));
          }
        }
        if (!lines.length) return { status: "done", text: T("Aucun élément.", "No items.") };
        return { status: "done", text: T(lines.map((l) => l.fr).join("\n"), lines.map((l) => l.en).join("\n")) };
      },
    },
    {
      name: "toggle_item",
      description: "Active ou désactive un élément (modèle, voix, connecteur, corps, avatar) quand l'utilisateur le demande. Désactivé = Floppy ne le voit plus, mais il n'est pas supprimé. Appelle-le tout de suite, sans confirmation. name : le nom dit par l'utilisateur. enabled : true pour activer, false pour désactiver.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, enabled: { type: "boolean" }, section },
        required: ["name", "enabled"],
      },
      level: "write",
      selfApproved: true,
      handler: async (a, meta) => {
        const hits = await cat.find(String(a.name ?? ""), typeof a.section === "string" ? a.section : undefined);
        if (!hits.length) return { status: "failed", text: T(`Je ne trouve pas « ${String(a.name)} ». Utilise list_items.`, `I can't find "${String(a.name)}". Use list_items.`) };
        if (hits.length > 1) return { status: "failed", text: T(`Plusieurs éléments correspondent : ${hits.map((h) => tr(h.item.label, "fr")).join(", ")}. Demande lequel.`, `Several items match: ${hits.map((h) => tr(h.item.label, "en")).join(", ")}. Ask which one.`) };
        const { provider, item } = hits[0]!;
        const on = a.enabled === true || a.enabled === "true";
        const r = await cat.run({ op: "enable", provider, id: item.id, on }, "voice", meta.origin);
        const text = r.ok && !r.text ? T(`${tr(item.label, "fr")} : ${on ? "activé" : "désactivé"}.`, `${tr(item.label, "en")}: ${on ? "on" : "off"}.`) : r.text;
        return { status: r.ok ? "done" : isRefusal(r.text) ? "refused" : "failed", text };
      },
    },
    {
      name: "use_item",
      description: "Passe sur un élément quand l'utilisateur le demande (« mets l'avatar chat », « change d'avatar pour le rond pixel »). Seulement les éléments qu'on peut choisir à la voix (ex. avatars) ; voir list_items. Appelle-le tout de suite, sans confirmation. name : le nom dit par l'utilisateur.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, section }, required: ["name"] },
      level: "write",
      selfApproved: true,
      handler: async (a, meta) => {
        const nom = String(a.name ?? "");
        const all = await cat.find(nom, typeof a.section === "string" ? a.section : undefined);
        // Un élément déjà en service n'a plus son bouton « use » : on le garde pour répondre « c'est déjà lui ».
        const hits = all.filter((h) => h.item.active || h.item.actions?.some((x) => x.id === "use" && x.voice));
        if (!hits.length) {
          return { status: "failed", text: all.length
            ? T(`${tr(all[0]!.item.label, "fr")} ne se choisit pas à la voix : utilise la fenêtre des réglages.`, `${tr(all[0]!.item.label, "en")} can't be chosen by voice: use the Settings window.`)
            : T(`Je ne trouve pas « ${nom} ». Utilise list_items.`, `I can't find "${nom}". Use list_items.`) };
        }
        if (hits.length > 1) return { status: "failed", text: T(`Plusieurs éléments correspondent : ${hits.map((h) => tr(h.item.label, "fr")).join(", ")}. Demande lequel.`, `Several items match: ${hits.map((h) => tr(h.item.label, "en")).join(", ")}. Ask which one.`) };
        const { provider, item } = hits[0]!;
        if (item.active) return { status: "done", text: T(`${tr(item.label, "fr")} est déjà en service.`, `${tr(item.label, "en")} is already in use.`) };
        const r = await cat.run({ op: "action", provider, id: item.id, action: "use" }, "voice", meta.origin);
        const text = r.ok ? T(`C'est ${tr(item.label, "fr")} maintenant.`, `It's ${tr(item.label, "en")} now.`) : r.text;
        return { status: r.ok ? "done" : isRefusal(r.text) ? "refused" : "failed", text };
      },
    },
    {
      name: "add_app",
      description: "Ajoute (installe) une application livrée avec l'assistant quand l'utilisateur le demande (« installe Orca », « ajoute le navigateur »). Voir list_items pour ce qu'on peut ajouter. Le noyau demande l'accord de l'utilisateur : appelle-le directement, sans redemander. name : le nom dit par l'utilisateur.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      level: "write",
      selfApproved: true,
      handler: async (a, meta) => {
        const nom = String(a.name ?? "");
        const hits = cat.findKind(nom);
        if (!hits.length) return { status: "failed", text: T(`Je n'ai pas d'application « ${nom} » à ajouter. Utilise list_items.`, `I have no "${nom}" app to add. Use list_items.`) };
        if (hits.length > 1) return { status: "failed", text: T(`Plusieurs applications correspondent : ${hits.map((h) => tr(h.kind.label, "fr")).join(", ")}. Demande laquelle.`, `Several apps match: ${hits.map((h) => tr(h.kind.label, "en")).join(", ")}. Ask which one.`) };
        const { provider, kind } = hits[0]!;
        // Déjà ajoutée (une seule permise) : rien à installer ; éteinte, elle se rallume avec toggle_item.
        const there = kind.single ? (await cat.provider(provider)!.list()).find((i) => i.kind === kind.id) : undefined;
        if (there) {
          return there.enabled
            ? { status: "done", text: T(`${tr(kind.label, "fr")} est déjà ajouté et allumé.`, `${tr(kind.label, "en")} is already added and on.`) }
            : { status: "failed", text: T(`${tr(kind.label, "fr")} est déjà ajouté mais éteint : utilise toggle_item pour l'allumer.`, `${tr(kind.label, "en")} is already added but off: use toggle_item to turn it on.`) };
        }
        const r = await cat.run({ op: "add", provider, kind: kind.id, values: {} }, "voice", meta.origin);
        const text = r.ok ? T(`${tr(kind.label, "fr")} ajouté. Ses outils arrivent dans un instant.`, `${tr(kind.label, "en")} added. Its tools will be ready in a moment.`) : r.text;
        return { status: r.ok ? "done" : isRefusal(r.text) ? "refused" : "failed", text };
      },
    },
  ];
}
