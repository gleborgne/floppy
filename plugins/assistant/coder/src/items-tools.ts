// Outils de l'assistant IA (mode « réglages ») pour les éléments : modèles, voix, connecteurs, corps, avatars.
// Ces outils existent SEULEMENT pour l'assistant de la fenêtre des réglages (jeton MCP restreint), jamais pour le
// cerveau à la voix.
// - list_item_types : ce qu'on peut ajouter, avec les champs de chaque formulaire (lecture).
// - add_item, edit_item, delete_item, try_item : chaque appel est montré à l'utilisateur
//   dans la fenêtre ; rien ne se fait sans son clic « Oui ». Ensuite l'opération part comme un clic (`via: "ui"`).
// - Les secrets (clés, jetons) ne passent jamais par la conversation : l'utilisateur les tape lui-même dans le
//   formulaire « Modifier » de l'élément.
import { tr, type Context, type CatalogOp, type FieldDef, type ProviderSnapshot } from "@floppy/core";
import type { ExtraTool } from "@floppy/contracts";
import { say, type RunnerDeps } from "./common.ts";

type Ask = RunnerDeps["ask"];

function fieldLine(f: FieldDef): string {
  const opts = f.options?.length ? ` (choix : ${f.options.map((o) => o.value).join(" | ")})` : "";
  const extra = [f.required ? "requis" : "", f.advanced ? "avancé" : "", f.showIf ? `si ${f.showIf.key} = ${f.showIf.values.join("/")}` : "",
    f.default !== undefined ? `défaut ${JSON.stringify(f.default)}` : ""].filter(Boolean).join(", ");
  const hint = f.hint ? ` — ${tr(f.hint)}` : "";
  return `    - ${f.key} : ${f.type}${opts}, « ${tr(f.label)} »${extra ? ` [${extra}]` : ""}${hint}`;
}

export function describeTypes(snap: ProviderSnapshot[], section?: string): string {
  const out: string[] = [];
  for (const p of snap) {
    if (section && p.section !== section) continue;
    out.push(`provider ${p.id} (section ${p.section}, « ${tr(p.label)} ») : ${p.items.length} élément(s)${p.can.update ? ", modifiable" : ""}${p.can.remove ? ", supprimable" : ""}`);
    for (const k of p.kinds) {
      out.push(`  type ${k.id} « ${tr(k.label)} »${k.cloud ? " [cloud]" : ""}${k.description ? ` : ${tr(k.description)}` : ""}`);
      for (const f of k.fields) out.push(fieldLine(f));
    }
  }
  return out.join("\n") || "Rien à ajouter dans cette rubrique.";
}

function secretKeys(snap: ProviderSnapshot[], provider: string, kind?: string): Set<string> {
  const p = snap.find((x) => x.id === provider);
  const kinds = p?.kinds.filter((k) => !kind || k.id === kind) ?? [];
  return new Set(kinds.flatMap((k) => k.fields.filter((f) => f.type === "secret").map((f) => f.key)));
}

function clean(values: unknown, secrets: Set<string>): { values: Record<string, unknown>; dropped: string[] } {
  const v = (values && typeof values === "object" ? { ...(values as Record<string, unknown>) } : {});
  const dropped = Object.keys(v).filter((k) => secrets.has(k));
  for (const k of dropped) delete v[k];
  return { values: v, dropped };
}

/** `lang` : langue des demandes montrées à l'utilisateur (langue de l'assistant). Les textes rendus au modèle restent en français. */
export function itemsTools(ctx: Context, ask: Ask, lang: () => string = () => "fr"): ExtraTool[] {
  const L = (fr: string, en: string): string => say(lang(), fr, en);
  const run = async (op: CatalogOp, description: string, input: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    const yes = await ask({ tool: op.op === "test" ? "try_item" : `${op.op === "add" ? "add" : op.op === "update" ? "edit" : "delete"}_item`, description, input });
    if (!yes) return { text: "L'utilisateur a refusé. Rien n'a changé. Ne réessaie pas à l'identique : demande-lui ce qu'il veut.", isError: true };
    const r = await ctx.items.run(op, "assistant");
    const kids = r.children?.length ? `\nSous-éléments : ${r.children.map((c) => `${c.id}${c.tag ? ` (${tr(c.tag)})` : ""}`).join(", ")}` : "";
    return { text: `${r.text}${r.id ? ` (id ${r.id})` : ""}${kids}`, isError: !r.ok };
  };
  const providerArg = { type: "string", description: "Id du fournisseur (voir list_item_types), ex. connectors, llm-local, llm-remote, voices." };

  return [
    {
      name: "list_item_types",
      description: "Ce qu'on peut ajouter (connecteurs MCP, commandes, modèles locaux ou distants, voix, corps…) : fournisseurs, types et champs de chaque formulaire. Appelle-le avant add_item. section : brain, voice, connectors, body, avatars (facultatif).",
      inputSchema: { type: "object", properties: { section: { type: "string" } } },
      handler: async (a) => ({ text: describeTypes(await ctx.items.snapshot(), typeof a.section === "string" ? a.section : undefined) }),
    },
    {
      name: "add_item",
      description: "Ajoute un élément (ex. un serveur MCP local ou distant, une commande, un modèle). L'utilisateur voit la demande et doit accepter. values : les champs du type (clés de list_item_types). Ne mets jamais de secret (clé, jeton, mot de passe) : laisse ces champs vides, l'utilisateur les remplira dans le formulaire « Modifier ».",
      inputSchema: {
        type: "object",
        properties: { provider: providerArg, type: { type: "string" }, values: { type: "object" } },
        required: ["provider", "type", "values"],
      },
      handler: async (a) => {
        const provider = String(a.provider ?? ""), kind = String(a.type ?? "");
        const { values, dropped } = clean(a.values, secretKeys(await ctx.items.snapshot(), provider, kind));
        const r = await run({ op: "add", provider, kind, values }, L(`Ajouter : ${String(values.label ?? values.name ?? kind)} (${provider} / ${kind})`, `Add: ${String(values.label ?? values.name ?? kind)} (${provider} / ${kind})`), { provider, type: kind, values });
        return dropped.length ? { ...r, text: `${r.text}\nSecrets non transmis (${dropped.join(", ")}) : dis à l'utilisateur de les taper dans « Modifier ».` } : r;
      },
    },
    {
      name: "edit_item",
      description: "Modifie un élément existant (champs à changer seulement). L'utilisateur doit accepter. Jamais de secret.",
      inputSchema: {
        type: "object",
        properties: { provider: providerArg, id: { type: "string" }, values: { type: "object" } },
        required: ["provider", "id", "values"],
      },
      handler: async (a) => {
        const provider = String(a.provider ?? ""), id = String(a.id ?? "");
        const { values } = clean(a.values, secretKeys(await ctx.items.snapshot(), provider));
        return run({ op: "update", provider, id, values }, L(`Modifier ${id} (${provider})`, `Edit ${id} (${provider})`), { provider, id, values });
      },
    },
    {
      name: "delete_item",
      description: "Supprime un élément. L'utilisateur doit accepter. Préfère toggle_item (désactiver) si l'utilisateur veut seulement ne plus l'utiliser.",
      inputSchema: { type: "object", properties: { provider: providerArg, id: { type: "string" } }, required: ["provider", "id"] },
      handler: async (a) => {
        const provider = String(a.provider ?? ""), id = String(a.id ?? "");
        return run({ op: "remove", provider, id }, L(`Supprimer ${id} (${provider})`, `Remove ${id} (${provider})`), { provider, id });
      },
    },
    {
      name: "try_item",
      description: "Essaie un élément avant de l'ajouter (ex. se connecter à un serveur MCP et lister ses outils). Peut lancer une commande : l'utilisateur doit accepter.",
      inputSchema: {
        type: "object",
        properties: { provider: providerArg, type: { type: "string" }, values: { type: "object" } },
        required: ["provider", "type", "values"],
      },
      handler: async (a) => {
        const provider = String(a.provider ?? ""), kind = String(a.type ?? "");
        const { values } = clean(a.values, secretKeys(await ctx.items.snapshot(), provider, kind));
        return run({ op: "test", provider, kind, values }, L(`Essayer : ${String(values.label ?? kind)} (${provider} / ${kind})`, `Try: ${String(values.label ?? kind)} (${provider} / ${kind})`), { provider, type: kind, values });
      },
    },
  ];
}
