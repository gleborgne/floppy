// Outils de l'assistant IA (mode « réglages ») pour les éléments : modèles, voix, connecteurs, corps, avatars.
// Ces outils existent SEULEMENT pour l'assistant de la fenêtre des réglages (jeton MCP restreint), jamais pour le
// cerveau à la voix.
// - types_elements : ce qu'on peut ajouter, avec les champs de chaque formulaire (lecture).
// - ajouter_element, modifier_element, supprimer_element, essayer_element : chaque appel est montré à l'utilisateur
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

export function describeTypes(snap: ProviderSnapshot[], rubrique?: string): string {
  const out: string[] = [];
  for (const p of snap) {
    if (rubrique && p.section !== rubrique) continue;
    out.push(`fournisseur ${p.id} (rubrique ${p.section}, « ${tr(p.label)} ») : ${p.items.length} élément(s)${p.can.update ? ", modifiable" : ""}${p.can.remove ? ", supprimable" : ""}`);
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
    const yes = await ask({ tool: op.op === "test" ? "essayer_element" : `${op.op === "add" ? "ajouter" : op.op === "update" ? "modifier" : "supprimer"}_element`, description, input });
    if (!yes) return { text: "L'utilisateur a refusé. Rien n'a changé. Ne réessaie pas à l'identique : demande-lui ce qu'il veut.", isError: true };
    const r = await ctx.items.run(op, "assistant");
    const kids = r.children?.length ? `\nSous-éléments : ${r.children.map((c) => `${c.id}${c.tag ? ` (${tr(c.tag)})` : ""}`).join(", ")}` : "";
    return { text: `${r.text}${r.id ? ` (id ${r.id})` : ""}${kids}`, isError: !r.ok };
  };
  const providerArg = { type: "string", description: "Id du fournisseur (voir types_elements), ex. connectors, llm-local, llm-remote, voices." };

  return [
    {
      name: "types_elements",
      description: "Ce qu'on peut ajouter (connecteurs MCP, commandes, modèles locaux ou distants, voix, corps…) : fournisseurs, types et champs de chaque formulaire. Appelle-le avant ajouter_element. rubrique : cerveau, voix, connecteurs, corps, avatars (facultatif).",
      inputSchema: { type: "object", properties: { rubrique: { type: "string" } } },
      handler: async (a) => ({ text: describeTypes(await ctx.items.snapshot(), typeof a.rubrique === "string" ? a.rubrique : undefined) }),
    },
    {
      name: "ajouter_element",
      description: "Ajoute un élément (ex. un serveur MCP local ou distant, une commande, un modèle). L'utilisateur voit la demande et doit accepter. valeurs : les champs du type (clés de types_elements). Ne mets jamais de secret (clé, jeton, mot de passe) : laisse ces champs vides, l'utilisateur les remplira dans le formulaire « Modifier ».",
      inputSchema: {
        type: "object",
        properties: { fournisseur: providerArg, type: { type: "string" }, valeurs: { type: "object" } },
        required: ["fournisseur", "type", "valeurs"],
      },
      handler: async (a) => {
        const provider = String(a.fournisseur ?? ""), kind = String(a.type ?? "");
        const { values, dropped } = clean(a.valeurs, secretKeys(await ctx.items.snapshot(), provider, kind));
        const r = await run({ op: "add", provider, kind, values }, L(`Ajouter : ${String(values.label ?? values.name ?? kind)} (${provider} / ${kind})`, `Add: ${String(values.label ?? values.name ?? kind)} (${provider} / ${kind})`), { fournisseur: provider, type: kind, valeurs: values });
        return dropped.length ? { ...r, text: `${r.text}\nSecrets non transmis (${dropped.join(", ")}) : dis à l'utilisateur de les taper dans « Modifier ».` } : r;
      },
    },
    {
      name: "modifier_element",
      description: "Modifie un élément existant (champs à changer seulement). L'utilisateur doit accepter. Jamais de secret.",
      inputSchema: {
        type: "object",
        properties: { fournisseur: providerArg, id: { type: "string" }, valeurs: { type: "object" } },
        required: ["fournisseur", "id", "valeurs"],
      },
      handler: async (a) => {
        const provider = String(a.fournisseur ?? ""), id = String(a.id ?? "");
        const { values } = clean(a.valeurs, secretKeys(await ctx.items.snapshot(), provider));
        return run({ op: "update", provider, id, values }, L(`Modifier ${id} (${provider})`, `Edit ${id} (${provider})`), { fournisseur: provider, id, valeurs: values });
      },
    },
    {
      name: "supprimer_element",
      description: "Supprime un élément. L'utilisateur doit accepter. Préfère activer_element (désactiver) si l'utilisateur veut seulement ne plus l'utiliser.",
      inputSchema: { type: "object", properties: { fournisseur: providerArg, id: { type: "string" } }, required: ["fournisseur", "id"] },
      handler: async (a) => {
        const provider = String(a.fournisseur ?? ""), id = String(a.id ?? "");
        return run({ op: "remove", provider, id }, L(`Supprimer ${id} (${provider})`, `Remove ${id} (${provider})`), { fournisseur: provider, id });
      },
    },
    {
      name: "essayer_element",
      description: "Essaie un élément avant de l'ajouter (ex. se connecter à un serveur MCP et lister ses outils). Peut lancer une commande : l'utilisateur doit accepter.",
      inputSchema: {
        type: "object",
        properties: { fournisseur: providerArg, type: { type: "string" }, valeurs: { type: "object" } },
        required: ["fournisseur", "type", "valeurs"],
      },
      handler: async (a) => {
        const provider = String(a.fournisseur ?? ""), kind = String(a.type ?? "");
        const { values } = clean(a.valeurs, secretKeys(await ctx.items.snapshot(), provider, kind));
        return run({ op: "test", provider, kind, values }, L(`Essayer : ${String(values.label ?? kind)} (${provider} / ${kind})`, `Try: ${String(values.label ?? kind)} (${provider} / ${kind})`), { fournisseur: provider, type: kind, valeurs: values });
      },
    },
  ];
}
