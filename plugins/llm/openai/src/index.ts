// Plugin `llm-openai` : modèles distants au format de l'API OpenAI (Mistral, OpenRouter, OpenAI, un serveur maison…).
// - Il ne lance rien : il garde la liste des modèles (adresse, nom du modèle, clé) et la donne au cerveau
//   par le service `llmRemote`. Les données partent dans le cloud : les activer à la voix demande l'accord.
// - La clé d'API va dans le coffre des secrets (ctx.secrets), jamais dans un fichier ni dans les valeurs renvoyées.
// - Les modèles de floppy.yml (`models`) sont la base ; l'utilisateur en ajoute, modifie, désactive, supprime
//   (gardé dans <home>/items/<id>.json).
import { z } from "zod";
import { parseModelJson } from "@floppy/agent-cli";
import {
  definePlugin, itemSecret, T, TextError, type FieldDef, type ItemInfo, type ItemKind, type OpResult, type Text,
} from "@floppy/core";

const ModelEntry = z.object({
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  baseURL: z.string(),
  model: z.string(),
  cloud: z.boolean().default(true),
});

const Config = z.object({
  /** Modèles de départ : { mistral: { label, baseURL, model } }. La clé se donne dans les réglages. */
  models: z.record(z.string(), ModelEntry).default({}),
  timeout_s: z.number().default(10),
});
type Config = z.infer<typeof Config>;

interface Values {
  label: string;
  aliases: string[];
  baseURL: string;
  model: string;
  cloud: boolean;
}
type Entry = Values & { id: string };

const FIELDS: FieldDef[] = [
  { key: "label", label: T("Nom affiché", "Display name"), type: "text", required: true, placeholder: "Mistral Large" },
  { key: "aliases", label: T("Mots pour le demander à la voix", "Words to ask for it by voice"), type: "list",
    hint: T("« Floppy, passe sur Mistral »", "\"Floppy, switch to Mistral\"") },
  { key: "baseURL", label: T("Adresse de base", "Base URL"), type: "text", required: true, placeholder: "https://api.mistral.ai/v1",
    hint: T("L'adresse qui se termine par /v1 (celle où se trouve /chat/completions).", "The address ending in /v1 (where /chat/completions lives).") },
  { key: "model", label: T("Nom du modèle", "Model name"), type: "text", required: true, placeholder: "mistral-large-latest" },
  { key: "apiKey", label: T("Clé d'API", "API key"), type: "secret",
    hint: T("Rangée dans le coffre de mots de passe du système, jamais dans un fichier.", "Stored in the OS credential manager, never in a file.") },
  { key: "cloud", label: T("Cloud (les données quittent le PC)", "Cloud (data leaves this PC)"), type: "boolean", default: true,
    hint: T("Décoche seulement pour un serveur de ton réseau local.", "Untick only for a server on your own network.") },
];

const KIND: ItemKind = {
  id: "openai",
  label: T("API compatible OpenAI", "OpenAI-compatible API"),
  description: T("Toute API au format OpenAI : adresse, modèle, clé.", "Any API in the OpenAI format: address, model, key."),
  fields: FIELDS,
  cloud: true,
};

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

function clean(v: Record<string, unknown>): Values {
  const aliases = Array.isArray(v.aliases) ? v.aliases.map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    label: String(v.label ?? "").trim(), aliases, baseURL: trimUrl(String(v.baseURL ?? "")), model: String(v.model ?? "").trim(),
    cloud: v.cloud === undefined ? true : Boolean(v.cloud),
  };
}

/** Trouve le JSON dans un texte (avec ou sans ```json, avec ou sans texte autour). */
function parseJson(text: string): unknown {
  const v = parseModelJson(text);
  if (v === undefined) throw new Error("pas de JSON");
  return v;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export default definePlugin<Config>({
  manifest: {
    id: "llm-openai",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "brain", label: { fr: "Cerveau", en: "Brain" } },
    ],
    description: "Modèles distants au format API OpenAI (Mistral, OpenRouter…) : adresse, modèle, clé dans le coffre.",
    provides: ["llm", "completion"],
    permissions: { net: ["*"], cloud: true },
    addable: { section: "brain", label: { fr: "API compatible OpenAI", en: "OpenAI-compatible API" }, description: { fr: "Mistral, OpenRouter, OpenAI… : adresse, modèle, clé.", en: "Mistral, OpenRouter, OpenAI…: address, model, key." }, cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const store = ctx.items.store();
    const base: Record<string, Values> = {};
    for (const [id, e] of Object.entries(cfg.models)) base[id] = clean(e);
    const secret = itemSecret(ctx, (id) => `llm-openai/${id}/apiKey`);
    const all = (): Entry[] => Object.entries(store.merge(base as unknown as Record<string, Record<string, unknown>>))
      .map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>), id }));
    const changed = () => ctx.items.changed();

    // Chaque modèle distant actif est offert comme `llm` : choisi dans un slot (ex. brain.main), il tourne dans un fork
    // (rien à lancer : juste l'adresse, le modèle et la clé lue à chaque appel).
    ctx.offer("llm", {
      items: () => all().filter((m) => store.isEnabled(m.id)).map((m) => ({ id: m.id, label: m.label, aliases: m.aliases, cloud: m.cloud })),
      start(f, id) {
        const m = all().find((x) => x.id === id && store.isEnabled(x.id));
        if (!m) throw new Error(`modèle distant inconnu ou désactivé : ${id}`);
        f.provide("llm", { label: m.label, baseURL: m.baseURL, model: m.model, cloud: m.cloud, apiKey: () => secret.get(m.id) });
      },
    });

    // Appel ponctuel (tri, résumé) : mêmes modèles, même clé. Avec un schéma : JSON structuré (sinon on lit le texte).
    ctx.offer("completion", {
      items: () => all().filter((m) => store.isEnabled(m.id)).map((m) => ({ id: m.id, label: m.label, aliases: m.aliases, cloud: m.cloud })),
      start(f, id) {
        const m = all().find((x) => x.id === id && store.isEnabled(x.id));
        if (!m) throw new Error(`modèle distant inconnu ou désactivé : ${id}`);
        f.provide("completion", {
          label: m.label, cloud: m.cloud,
          async complete(req) {
            const key = secret.get(m.id);
            const system = req.schema ? `${req.system}\nRéponds seulement avec un JSON valide qui suit ce schéma : ${JSON.stringify(req.schema)}` : req.system;
            const body: Record<string, unknown> = { model: m.model, messages: [{ role: "system", content: system }, { role: "user", content: req.prompt }] };
            if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: req.schema, strict: false } };
            let r: Response;
            try {
              // Même borne qu'avant (6 × timeout_s, réponse entière), portée par ctx.fetch du fork.
              r = await f.fetch(`${m.baseURL}/chat/completions`, {
                method: "POST", timeoutMs: cfg.timeout_s * 1000 * 6, ...(req.signal ? { signal: req.signal } : {}),
                headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
                body: JSON.stringify(body),
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              throw new TextError(T(`Impossible de joindre ${m.label} : ${msg}`, `Can't reach ${m.label}: ${msg}`));
            }
            if (r.status === 401 || r.status === 403) throw new TextError(T(`${m.label} refuse la clé d'API (erreur ${r.status}).`, `${m.label} rejects the API key (error ${r.status}).`));
            if (!r.ok) throw new TextError(T(`${m.label} répond avec une erreur ${r.status}.`, `${m.label} answers with error ${r.status}.`));
            let text = "";
            try { text = String(((await r.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content ?? ""); }
            catch { throw new TextError(T(`${m.label} : réponse illisible.`, `${m.label}: unreadable answer.`)); }
            if (!req.schema) return { text: text.trim() };
            try { return { text: text.trim(), json: parseJson(text) }; }
            catch {
              const t = text.trim().slice(0, 120);
              throw new TextError(T(`${m.label} n'a pas donné de JSON valide : ${t}`, `${m.label} didn't return valid JSON: ${t}`));
            }
          },
        });
      },
    });

    const info = (m: Entry): ItemInfo => {
      const on = store.isEnabled(m.id);
      return {
        id: m.id, label: m.label, kind: "openai", aliases: m.aliases, enabled: on, cloud: m.cloud,
        detail: `${m.model} · ${hostOf(m.baseURL)}`,
        status: !on ? "off" : secret.has(m.id) ? "ok" : "warn",
        statusText: !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
          : secret.has(m.id) ? undefined : T("pas de clé d'API", "no API key"),
        values: { ...m, apiKey: secret.shown(m.id) } as unknown as Record<string, unknown>,
        editable: true, removable: true, toggleable: true,
      };
    };


    const check = (v: Values): Text | undefined => {
      if (!v.label) return T("Il faut un nom.", "A name is required.");
      if (!/^https?:\/\//i.test(v.baseURL)) return T("L'adresse doit commencer par http:// ou https://.", "The address must start with http:// or https://.");
      if (!v.model) return T("Il faut le nom du modèle.", "The model name is required.");
      return undefined;
    };

    ctx.items.declare({
      id: "llm-remote", section: "brain", order: 20, offers: "llm",
      label: T("API compatible OpenAI", "OpenAI-compatible API"),
      description: T("Toute API au format OpenAI : adresse, modèle, clé. Les données partent dans le cloud.", "Any OpenAI-format API: address, model, key. Data goes to the cloud."),
      addLabel: T("Ajouter un modèle distant", "Add a remote model"),
      badge: T("cloud", "cloud"),
      kinds: [KIND],
      list: () => all().map(info),
      add: async (kind, values): Promise<OpResult> => {
        if (kind !== "openai") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
        const v = clean(values);
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        const id = store.add("openai", v as unknown as Record<string, unknown>, v.label, Object.keys(base));
        secret.apply(id, values.apiKey);
        changed();
        return { ok: true, id, text: T(`${v.label} ajouté. Active-le comme cerveau quand tu veux.`, `${v.label} added. Activate it as the brain whenever you like.`) };
      },
      update: async (id, values) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        const v = clean({ ...cur, ...values });
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        store.update(id, v as unknown as Record<string, unknown>);
        secret.apply(id, values.apiKey);
        changed();
        return { ok: true, id, text: T(`${v.label} modifié.`, `${v.label} updated.`) };
      },
      remove: async (id) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        store.remove(id);
        secret.remove(id);
        changed();
        return { ok: true, text: T(`${cur.label} supprimé.`, `${cur.label} deleted.`) };
      },
      setEnabled: async (id, on) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        store.setEnabled(id, on);
        changed();
        return { ok: true, text: on ? T(`${cur.label} activé.`, `${cur.label} enabled.`)
          : T(`${cur.label} désactivé : Floppy ne le voit plus (rien n'est supprimé).`, `${cur.label} disabled: Floppy no longer sees it (nothing is deleted).`) };
      },
      test: async (_kind, values, id): Promise<OpResult> => {
        const v = clean(values);
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        const typed = values.apiKey;
        const key = secret.typedOr(id, typed);
        const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
        // Test : timeout_s pour chaque appel (réponse entière), par ctx.fetch.
        const timeoutMs = cfg.timeout_s * 1000;
        try {
          const r = await ctx.fetch(`${v.baseURL}/models`, { headers, timeoutMs });
          if (r.ok) {
            let ids: string[] = [];
            try { ids = ((await r.json()) as { data?: { id?: string }[] }).data?.map((d) => String(d.id)) ?? []; } catch { /* pas du JSON */ }
            if (ids.length && !ids.includes(v.model)) return { ok: true, text: T(`L'API répond, mais le modèle « ${v.model} » n'est pas dans sa liste (${ids.length} modèles).`, `The API answers, but model "${v.model}" isn't in its list (${ids.length} models).`) };
            return { ok: true, text: T(`Ça marche : l'API répond${ids.length ? ` (${ids.length} modèles)` : ""}.`, `It works: the API answers${ids.length ? ` (${ids.length} models)` : ""}.`) };
          }
          if (r.status === 401 || r.status === 403) return { ok: false, text: T(`L'API refuse la clé (erreur ${r.status}).`, `The API rejects the key (error ${r.status}).`) };
          // Certaines API n'ont pas /models : un tout petit message à la place.
          const c = await ctx.fetch(`${v.baseURL}/chat/completions`, {
            method: "POST", headers, timeoutMs,
            body: JSON.stringify({ model: v.model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
          });
          if (c.ok) return { ok: true, text: T("Ça marche : le modèle a répondu.", "It works: the model answered.") };
          return { ok: false, text: T(`L'API répond avec une erreur ${c.status}.`, `The API answers with error ${c.status}.`) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, text: T(`Impossible de joindre l'API : ${msg}`, `Can't reach the API: ${msg}`) };
        }
      },
    });

  },
});
