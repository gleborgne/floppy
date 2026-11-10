// Fournisseur d'éléments « connectors » (rubrique Connecteurs) : serveurs MCP locaux, distants, commandes.
// Les serveurs de floppy.yml sont la base ; ItemStore garde les ajouts, modifications, désactivations
// et le choix des outils de l'utilisateur. Tout se change à chaud, un connecteur à la fois.
import {
  ItemStore, TextError, tr,
  type Context, type FieldDef, type ItemChild, type ItemInfo, type ItemKind, type OpResult, type ProviderDef, type Text,
} from "@floppy/core";
import { matchesAny } from "./levels.ts";
import { AZURE_DEVOPS, OBSIDIAN } from "./logos.ts";
import { connectorSecrets, errText, makeConnection, open, wrap, type Connection, type RawTool, type Spec } from "./connection.ts";

type Raw = Record<string, unknown>;
type Values = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** Un champ « clé / valeur » arrive en objet ou en liste de paires. */
function record(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const p of v) {
      const [k, val] = Array.isArray(p) ? p : [(p as Raw)?.key, (p as Raw)?.value];
      if (typeof k === "string" && k.trim()) out[k.trim()] = String(val ?? "");
    }
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) if (k.trim()) out[k.trim()] = String(val ?? "");
  }
  return out;
}

/** Valeurs d'un élément (config + modifications) → Spec. */
export function toSpec(raw: Raw): Spec {
  const include = list(raw.include);
  const auth = raw.auth as Spec["auth"] | null | undefined;
  return {
    kind: (raw.kind as Spec["kind"] | undefined) ?? (raw.url ? "mcp-remote" : "mcp-local"),
    ...(raw.label ? { label: String(raw.label) } : {}),
    ...(raw.command ? { command: String(raw.command) } : {}),
    args: list(raw.args),
    env: record(raw.env),
    ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
    ...(raw.url ? { url: String(raw.url) } : {}),
    headers: record(raw.headers),
    ...(auth ? { auth } : {}),
    cloud: raw.cloud === true,
    levels: (raw.levels ?? {}) as Spec["levels"],
    ...(raw.trustAnnotations === true || raw.trust_annotations === true ? { trustAnnotations: true } : {}),
    ...(include.length ? { include } : {}),
    exclude: list(raw.exclude),
    ...(raw.secretEnvName ? { secretEnvName: String(raw.secretEnvName) } : {}),
    ...(raw.description ? { description: String(raw.description) } : {}),
    ...(raw.note ? { note: String(raw.note) } : {}),
    ...(raw.level ? { level: raw.level as Spec["level"] } : {}),
    ...(typeof raw.timeoutS === "number" ? { timeoutS: raw.timeoutS } : {}),
  };
}

// --------------------------------------------------------------------------- formulaires

const t = (fr: string, en: string): Text => ({ fr, en });

const labelField = (ph: Text): FieldDef => ({ key: "label", label: t("Nom", "Name"), type: "text", required: true, placeholder: ph });
const cloudHint = t("Ses données vont dans le cloud : l'allumer à la voix demandera ton accord.", "Its data goes to the cloud: turning it on by voice will ask for your approval.");

export const KINDS: ItemKind[] = [
  {
    id: "mcp-local",
    label: t("Serveur MCP local", "Local MCP server"),
    description: t("Une commande lancée sur ton PC (npx, python, exe…). Ex. Office 365, fichiers, Obsidian.", "A command run on your PC (npx, python, exe…). E.g. Office 365, files, Obsidian."),
    fields: [
      labelField(t("Ex. Obsidian", "E.g. Obsidian")),
      { key: "command", label: t("Commande", "Command"), type: "text", required: true, placeholder: "npx" },
      { key: "args", label: t("Arguments", "Arguments"), type: "list", hint: t("Un argument par ligne, comme dans la documentation du serveur.", "One argument per line, as in the server's documentation.") },
      { key: "env", label: t("Variables d'environnement", "Environment variables"), type: "keyvalue", advanced: true },
      { key: "secretEnvName", label: t("Nom de la variable secrète", "Secret variable name"), type: "text", advanced: true, placeholder: "API_KEY" },
      {
        key: "secretEnvValue", label: t("Valeur secrète", "Secret value"), type: "secret", advanced: true,
        hint: t("Rangée dans le coffre de mots de passe du système, jamais dans un fichier.", "Kept in the system password vault, never in a file."),
      },
      { key: "cloud", label: t("Données dans le cloud", "Data in the cloud"), type: "boolean", default: false, hint: cloudHint },
      { key: "levels", label: t("Niveau par outil", "Level per tool"), type: "keyvalue", advanced: true, hint: t("outil = read (sans accord), write, send, delete (avec accord) ou never (interdit). Ex. : ask = read. Par défaut, un outil inconnu demande ton accord.", "tool = read (no approval), write, send, delete (with approval) or never (forbidden). E.g.: ask = read. By default, an unknown tool asks for your approval.") },
      { key: "note", label: t("Note pour le cerveau", "Note for the brain"), type: "textarea", advanced: true, hint: t("Ajoutée à la description de ses outils. Ex. : adresse web d'une PR = https://dev.azure.com/<org>/<projet>/_git/<dépôt>/pullrequest/<id>", "Added to its tools' description. E.g.: a PR web address = https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>") },
      { key: "toolFilter", label: t("Filtre d'outils", "Tool filter"), type: "list", advanced: true, hint: t("Seuls ces outils sont donnés au cerveau (jokers * permis). Vide = tous.", "Only these tools are given to the brain (wildcards * allowed). Empty = all.") },
    ],
  },
  {
    id: "mcp-remote",
    label: t("Serveur MCP distant", "Remote MCP server"),
    description: t("Une adresse web (HTTP). Connexion par jeton ou Azure CLI. Ex. Azure DevOps.", "A web address (HTTP). Sign in with a token or Azure CLI. E.g. Azure DevOps."),
    cloud: true,
    fields: [
      labelField(t("Ex. Azure DevOps", "E.g. Azure DevOps")),
      { key: "url", label: t("Adresse", "Address"), type: "text", required: true, placeholder: "https://…/mcp" },
      {
        key: "connection", label: t("Connexion", "Sign-in"), type: "select", default: "none",
        options: [
          { value: "none", label: t("Aucune", "None") },
          { value: "token", label: t("Jeton", "Token") },
          { value: "azcli", label: t("Azure CLI (az login)", "Azure CLI (az login)") },
        ],
      },
      { key: "token", label: t("Jeton", "Token"), type: "secret", showIf: { key: "connection", values: ["token"] }, hint: t("Rangé dans le coffre de mots de passe du système.", "Kept in the system password vault.") },
      { key: "resource", label: t("Ressource Azure", "Azure resource"), type: "text", showIf: { key: "connection", values: ["azcli"] }, placeholder: "https://mcp.dev.azure.com" },
      { key: "cloud", label: t("Données dans le cloud", "Data in the cloud"), type: "boolean", default: true, hint: cloudHint },
      { key: "levels", label: t("Niveau par outil", "Level per tool"), type: "keyvalue", advanced: true, hint: t("outil = read (sans accord), write, send, delete (avec accord) ou never (interdit). Ex. : ask = read. Par défaut, un outil inconnu demande ton accord.", "tool = read (no approval), write, send, delete (with approval) or never (forbidden). E.g.: ask = read. By default, an unknown tool asks for your approval.") },
      { key: "trustAnnotations", label: t("Croire ses outils « lecture seule »", "Trust its \"read-only\" tools"), type: "boolean", default: false, advanced: true, hint: t("Le serveur marque certains outils « lecture seule » : ils passent alors sans accord. À cocher seulement pour un serveur de confiance.", "The server marks some tools \"read-only\": they then run without approval. Tick only for a server you trust.") },
      { key: "note", label: t("Note pour le cerveau", "Note for the brain"), type: "textarea", advanced: true, hint: t("Ajoutée à la description de ses outils. Ex. : adresse web d'une PR = https://dev.azure.com/<org>/<projet>/_git/<dépôt>/pullrequest/<id>", "Added to its tools' description. E.g.: a PR web address = https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>") },
      { key: "toolFilter", label: t("Filtre d'outils", "Tool filter"), type: "list", advanced: true, hint: t("Seuls ces outils sont donnés au cerveau (jokers * permis). Vide = tous.", "Only these tools are given to the brain (wildcards * allowed). Empty = all.") },
    ],
  },
  {
    id: "command",
    label: t("Commande", "Command"),
    description: t("Une ligne de commande transformée en outil (ex. « git status » d'un dossier).", "A command line turned into a tool (e.g. “git status” of a folder)."),
    fields: [
      { key: "label", label: t("Nom de l'outil", "Tool name"), type: "text", required: true, placeholder: t("Ex. état git", "E.g. git status") },
      { key: "description", label: t("Description", "Description"), type: "textarea", required: true, hint: t("Dit au cerveau quand utiliser l'outil.", "Tells the brain when to use the tool.") },
      { key: "command", label: t("Commande", "Command"), type: "text", required: true, placeholder: "git" },
      { key: "args", label: t("Arguments", "Arguments"), type: "list", hint: t("Un argument peut contenir {text} : remplacé par ce que le modèle donne.", "An argument may contain {text}: replaced by what the model gives.") },
      { key: "cwd", label: t("Dossier de travail", "Working folder"), type: "path", directory: true },
      {
        key: "level", label: t("Niveau", "Level"), type: "select", default: "write",
        options: [{ value: "write", label: t("Écriture (accord)", "Write (approval)") }, { value: "read", label: t("Lecture (libre)", "Read (free)") }],
      },
      { key: "timeoutS", label: t("Délai maximum (secondes)", "Time limit (seconds)"), type: "number", default: 30, min: 1, max: 600, advanced: true },
    ],
  },
];

const LEVELS = ["read", "write", "send", "delete", "physical", "never"];

/** Champ « Niveau par outil » : clé / valeur, chaque valeur doit être un niveau connu. */
function levelsOf(v: unknown): Record<string, string> {
  const out = record(v);
  for (const [k, lv] of Object.entries(out)) {
    if (!LEVELS.includes(lv.trim())) {
      throw new TextError(t(
        `Niveau inconnu pour « ${k} » : « ${lv} ». Choisis read, write, send, delete, physical ou never.`,
        `Unknown level for “${k}”: “${lv}”. Choose read, write, send, delete, physical or never.`,
      ));
    }
    out[k] = lv.trim();
  }
  return out;
}

/** Valeurs du formulaire → morceau de Spec à garder (sans aucun secret). */
export function formToPatch(kind: string, v: Values): Raw {
  const label = str(v.label);
  if (!label) throw new TextError(t("Donne un nom.", "Give a name."));
  if (kind === "mcp-local") {
    if (!str(v.command)) throw new TextError(t("La commande est à remplir.", "The command is required."));
    return {
      kind, label, command: str(v.command), args: list(v.args), env: record(v.env), cloud: v.cloud === true,
      ...(list(v.toolFilter).length ? { include: list(v.toolFilter) } : {}), // vide : on garde l'include de la config
      levels: levelsOf(v.levels), note: str(v.note) || null, secretEnvName: str(v.secretEnvName) || null,
    };
  }
  if (kind === "mcp-remote") {
    const url = str(v.url);
    try { if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(); } catch { throw new TextError(t("L'adresse doit être une URL http ou https.", "The address must be an http or https URL.")); }
    const conn = str(v.connection) || "none";
    let auth: Spec["auth"] | null = null;
    if (conn === "azcli") {
      const resource = str(v.resource);
      if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(resource)) throw new TextError(t("Ressource Azure invalide.", "Invalid Azure resource."));
      auth = { type: "azcli", resource };
    } else if (conn === "token") auth = { type: "token" };
    return { kind, label, url, auth, cloud: v.cloud !== false, ...(list(v.toolFilter).length ? { include: list(v.toolFilter) } : {}), levels: levelsOf(v.levels), trustAnnotations: v.trustAnnotations === true, note: str(v.note) || null };
  }
  if (kind === "command") {
    if (!str(v.command)) throw new TextError(t("La commande est à remplir.", "The command is required."));
    const level = v.level === "read" ? "read" : "write"; // défaut : avec accord
    const timeoutS = typeof v.timeoutS === "number" ? v.timeoutS : Number(v.timeoutS ?? 30);
    return {
      kind, label, description: str(v.description), command: str(v.command), args: list(v.args),
      cwd: str(v.cwd) || null, level, timeoutS: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 30,
    };
  }
  throw new TextError(t(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`));
}

// --------------------------------------------------------------------------- niveaux

const LEVEL_TAG: Record<string, { tag: Text; tone: ItemChild["tone"] }> = {
  read: { tag: t("lecture · libre", "read · free"), tone: "ok" },
  write: { tag: t("écriture · accord", "write · approval"), tone: "warn" },
  send: { tag: t("envoi · accord", "send · approval"), tone: "warn" },
  delete: { tag: t("suppression · accord", "delete · approval"), tone: "danger" },
};
const NEVER_TAG = { tag: t("interdit", "forbidden"), tone: "danger" as const };

function childOf(tool: Pick<RawTool, "name" | "level" | "rule" | "description">, enabled: boolean): ItemChild {
  const lv = tool.rule === "never" ? NEVER_TAG : (LEVEL_TAG[tool.level] ?? LEVEL_TAG.write!);
  return { id: tool.name, label: tool.name, ...(tool.description ? { detail: tool.description.slice(0, 160) } : {}), enabled, tag: lv.tag, ...(lv.tone ? { tone: lv.tone } : {}) };
}

/**
 * Logo d'une marque connue, pour un serveur qui n'envoie pas le sien : d'après son adresse (serveur distant)
 * ou sa commande et ses arguments (serveur local). Rien pour une commande transformée en outil.
 */
export function brandLogo(spec: Spec): string | undefined {
  if (spec.kind === "command") return undefined;
  let host = "";
  try { host = spec.url ? new URL(spec.url).hostname.toLowerCase() : ""; } catch { /* adresse invalide */ }
  const text = [spec.command, ...spec.args].join(" ").toLowerCase();
  if (/(^|\.)dev\.azure\.com$/.test(host) || /(^|\.)visualstudio\.com$/.test(host) || /azure-devops/.test(text)) return AZURE_DEVOPS;
  if (/(^|[^a-z])obsidian/.test(text) || /(^|\.)obsidian\.md$/.test(host)) return OBSIDIAN;
  return undefined;
}

/** Un outil est donné au cerveau : choix de l'utilisateur d'abord, sinon include puis exclude de la config. */
export function passes(name: string, spec: Spec, override?: boolean): boolean {
  if (override !== undefined) return override;
  return (!spec.include?.length || matchesAny(name, spec.include)) && !matchesAny(name, spec.exclude);
}

// --------------------------------------------------------------------------- fournisseur

const UNKNOWN = t("Connecteur inconnu.", "Unknown connector.");

const KIND_NAME: Record<Spec["kind"], Text> = {
  "mcp-local": t("MCP local", "Local MCP"),
  "mcp-remote": t("MCP distant", "Remote MCP"),
  command: t("Commande", "Command"),
};

interface Cached { name: string; level: RawTool["level"]; rule?: RawTool["rule"]; description?: string }

export interface ConnectorsHandle {
  /** Allume (ou garde éteints) les connecteurs au démarrage. Un échec n'arrête pas les autres. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Délai de l'essai d'un connecteur (modifiable par les tests). */
export const TEST_LIMIT = { ms: 30_000 };

export function declareConnectors(ctx: Context, base: Record<string, Raw>): ConnectorsHandle {
  const store = ctx.items.store();
  const sec = connectorSecrets(ctx);
  const baseIds = Object.keys(base);
  const x = store.data.extra as { migrated?: boolean; enabled?: string[]; tools?: Record<string, Cached[]> };

  // Une seule fois : reprendre les anciens réglages « connecteur_<clé> » (allumé / éteint).
  if (!x.migrated) {
    x.enabled ??= [];
    for (const id of [...baseIds, ...Object.keys(store.data.added)]) {
      const old = ctx.settings.saved<boolean>("connecteur_" + id.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
      if (typeof old !== "boolean") continue;
      store.data.disabled = store.data.disabled.filter((d) => d !== id);
      x.enabled = x.enabled.filter((d) => d !== id);
      if (!old) store.data.disabled.push(id);
      else x.enabled.push(id);
    }
    x.migrated = true;
    store.save();
  }
  x.enabled ??= [];
  x.tools ??= {};

  const merged = (): Record<string, Raw> => store.merge(base) as Record<string, Raw>;
  const specOf = (id: string): Spec | undefined => { const r = merged()[id]; return r ? toSpec(r) : undefined; };
  const isOn = (id: string): boolean => {
    const r = merged()[id];
    if (!r) return false;
    if (!store.isEnabled(id)) return false;
    return r.disabled === true && !r._added ? x.enabled!.includes(id) : true;
  };

  const conns = new Map<string, Connection>();
  const connOf = (id: string): Connection => {
    let c = conns.get(id);
    if (!c) {
      c = makeConnection(ctx, id, {
        spec: () => specOf(id)!,
        visible: (name) => passes(name, specOf(id)!, store.child(id, name)),
        onTools: (tools) => {
          const next: Cached[] = tools.map((tl) => ({ name: tl.name, level: tl.level, ...(tl.rule ? { rule: tl.rule } : {}), description: tl.description.slice(0, 160) }));
          if (JSON.stringify(x.tools![id]) !== JSON.stringify(next)) { x.tools![id] = next; store.save(); }
        },
        onChange: () => ctx.items.changed(),
      });
      conns.set(id, c);
    }
    return c;
  };

  const saveSecrets = (id: string, kind: string, v: Values): void => {
    if (kind === "mcp-local") {
      if (str(v.secretEnvName)) sec.env.apply(id, v.secretEnvValue);
      else sec.env.remove(id);
    }
    if (kind === "mcp-remote") {
      if (str(v.connection) === "token") sec.token.apply(id, v.token);
      else sec.token.remove(id);
    }
  };

  const childrenOf = (id: string, spec: Spec): ItemChild[] => {
    if (spec.kind === "command") return [];
    const c = conns.get(id);
    const tools: Cached[] = c && c.tools().length ? c.tools() : (x.tools![id] ?? []);
    return tools.map((tl) => childOf({ ...tl, description: tl.description ?? "" }, passes(tl.name, spec, store.child(id, tl.name))));
  };

  const formValues = (id: string, spec: Spec): Values => {
    if (spec.kind === "command") {
      return { label: spec.label ?? id, description: spec.description ?? "", command: spec.command ?? "", args: spec.args, cwd: spec.cwd ?? "", level: spec.level ?? "write", timeoutS: spec.timeoutS ?? 30 };
    }
    if (spec.kind === "mcp-remote") {
      return {
        label: spec.label ?? id, url: spec.url ?? "", cloud: spec.cloud,
        connection: spec.auth?.type ?? "none",
        ...(spec.auth?.type === "token" ? { token: sec.token.shown(id) } : {}),
        ...(spec.auth?.type === "azcli" ? { resource: spec.auth.resource } : {}),
        toolFilter: spec.include ?? [], levels: spec.levels, trustAnnotations: spec.trustAnnotations === true, note: spec.note ?? "",
      };
    }
    return {
      label: spec.label ?? id, command: spec.command ?? "", args: spec.args, env: spec.env, cloud: spec.cloud,
      secretEnvName: spec.secretEnvName ?? "",
      ...(spec.secretEnvName ? { secretEnvValue: sec.env.shown(id) } : {}),
      toolFilter: spec.include ?? [], levels: spec.levels, note: spec.note ?? "",
    };
  };

  const infoOf = (id: string, raw: Raw): ItemInfo => {
    const spec = toSpec(raw);
    const on = isOn(id);
    const c = conns.get(id);
    const st = c?.state() ?? "off";
    const total = childrenOf(id, spec).length;
    let status: ItemInfo["status"] = "off";
    let statusText: Text = t("éteint", "off");
    if (on) {
      if (st === "connecting" || (st === "off" && !c)) { status = "loading"; statusText = t("connexion en cours", "connecting"); }
      else if (st === "error") { status = "error"; statusText = wrap(c!.error(), (s) => `erreur : ${s}`, (s) => `error: ${s}`); }
      else if (st === "on") {
        status = "ok";
        const n = c!.visibleCount();
        statusText = spec.kind === "command" ? t("prêt", "ready")
          : total > n ? t(`connecté · ${n} outil${n > 1 ? "s" : ""} sur ${total}`, `connected · ${n} tool${n > 1 ? "s" : ""} of ${total}`)
          : t(`connecté · ${n} outil${n > 1 ? "s" : ""}`, `connected · ${n} tool${n > 1 ? "s" : ""}`);
      } else { status = "off"; statusText = t("éteint", "off"); }
    }
    const label = spec.label ?? id;
    const logo = c?.icon() ?? brandLogo(spec);
    return {
      id, label, ...(logo ? { logo } : {}), enabled: on, status, statusText, cloud: spec.cloud, kind: spec.kind,
      detail: spec.url ?? [spec.command, ...spec.args].filter(Boolean).join(" "),
      tags: [tr(KIND_NAME[spec.kind], "fr")],
      values: formValues(id, spec),
      editable: true, removable: true, toggleable: true,
      children: childrenOf(id, spec),
      aliases: [id, label],
    };
  };

  const afterChange = (): void => ctx.items.changed();

  const def: ProviderDef = {
    id: "connectors",
    section: "connectors",
    label: t("Connecteurs", "Connectors"),
    description: t("Serveurs MCP et commandes que Floppy peut utiliser.", "MCP servers and commands Floppy can use."),
    order: 10,
    kinds: KINDS,
    addLabel: t("Ajouter un connecteur", "Add a connector"),
    childrenLabel: t("Outils donnés au cerveau", "Tools given to the brain"),
    list: () => Object.entries(merged()).map(([id, raw]) => infoOf(id, raw)),

    async add(kind, values) {
      let patch: Raw;
      try { patch = formToPatch(kind, values); } catch (e) { return { ok: false, text: errText(e) }; }
      const id = store.add(kind, patch, String(patch.label), baseIds);
      x.enabled = x.enabled!.filter((d) => d !== id);
      store.save();
      saveSecrets(id, kind, values);
      const name = String(patch.label);
      let text: Text = t(`« ${name} » est ajouté et allumé.`, `“${name}” is added and turned on.`);
      let ok = true;
      try { await connOf(id).connect(); } catch (e) {
        ok = false;
        text = wrap(errText(e), (s) => `« ${name} » est ajouté, mais la connexion échoue : ${s}`, (s) => `“${name}” is added, but the connection fails: ${s}`);
      }
      afterChange();
      return { ok, text, id, children: childrenOf(id, toSpec(merged()[id]!)) };
    },

    async update(id, values) {
      const cur = specOf(id);
      if (!cur) return { ok: false, text: UNKNOWN };
      let patch: Raw;
      try { patch = formToPatch(cur.kind, values); } catch (e) { return { ok: false, text: errText(e) }; }
      // Le choix des outils par l'utilisateur est gardé ; le filtre vient du formulaire.
      store.update(id, patch);
      saveSecrets(id, cur.kind, values);
      const c = connOf(id);
      let text: Text = t("Modifié.", "Updated.");
      let ok = true;
      await c.disconnect();
      if (isOn(id)) {
        try { await c.connect(); } catch (e) { ok = false; text = wrap(errText(e), (s) => `Modifié, mais la connexion échoue : ${s}`, (s) => `Updated, but the connection fails: ${s}`); }
      }
      afterChange();
      return { ok, text, id };
    },

    async remove(id) {
      if (!merged()[id]) return { ok: false, text: UNKNOWN };
      await conns.get(id)?.disconnect();
      conns.delete(id);
      store.remove(id);
      x.enabled = x.enabled!.filter((d) => d !== id);
      delete x.tools![id];
      store.save();
      sec.env.remove(id);
      sec.token.remove(id);
      afterChange();
      return { ok: true, text: t("Connecteur supprimé.", "Connector removed.") };
    },

    async setEnabled(id, on) {
      const raw = merged()[id];
      if (!raw) return { ok: false, text: UNKNOWN };
      store.setEnabled(id, on);
      x.enabled = x.enabled!.filter((d) => d !== id);
      if (on) x.enabled.push(id);
      store.save();
      const c = connOf(id);
      if (!on) { await c.disconnect(); afterChange(); return { ok: true, text: t("Éteint.", "Turned off.") }; }
      try { await c.connect(); } catch (e) {
        afterChange();
        return { ok: false, text: wrap(errText(e), (s) => `Allumé, mais la connexion échoue : ${s}`, (s) => `Turned on, but the connection fails: ${s}`) };
      }
      afterChange();
      return { ok: true, text: t("Allumé.", "Turned on.") };
    },

    async setChild(id, childId, on) {
      if (!merged()[id]) return { ok: false, text: UNKNOWN };
      store.setChild(id, childId, on);
      conns.get(id)?.refilter();
      afterChange();
      return { ok: true, text: on ? t("Outil donné au cerveau.", "Tool given to the brain.") : t("Outil retiré.", "Tool removed.") };
    },

    async test(kind, values, id): Promise<OpResult> {
      let spec: Spec;
      try { spec = toSpec(formToPatch(kind, values)); } catch (e) { return { ok: false, text: errText(e) }; }
      // Secret non modifié : on prend celui déjà rangé.
      let secret: string | undefined;
      if (spec.auth?.type === "token") secret = sec.token.typedOr(id, values.token);
      else if (spec.secretEnvName) secret = sec.env.typedOr(id, values.secretEnvValue);
      const tid = id ?? "essai";
      let timer: NodeJS.Timeout | undefined;
      const limit = TEST_LIMIT.ms;
      const opening = open(tid, spec, secret, { fetch: ctx.fetch });
      try {
        const o = await Promise.race([
          opening,
          new Promise<never>((_, ko) => { timer = setTimeout(() => ko(new TextError(t(`pas de réponse après ${Math.round(limit / 1000)} s`, `no answer after ${Math.round(limit / 1000)} s`))), limit); }),
        ]);
        await o.close();
        const children = o.tools.map((tl) => childOf(tl, passes(tl.name, spec, id ? store.child(id, tl.name) : undefined)));
        const kept = children.filter((c) => c.enabled).length;
        const n = children.length;
        return {
          ok: true,
          text: kind === "command" ? t("La commande est prête.", "The command is ready.")
            : t(`Connecté : ${n} outil${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""}, ${kept} donné${kept > 1 ? "s" : ""} au cerveau.`,
              `Connected: ${n} tool${n > 1 ? "s" : ""} found, ${kept} given to the brain.`),
          children,
        };
      } catch (e) {
        // Si open() aboutit après le délai, on ferme tout de suite : pas de processus laissé derrière.
        void opening.then((o) => o.close(), () => {});
        return { ok: false, text: wrap(errText(e), (s) => `Connexion impossible : ${s}`, (s) => `Cannot connect: ${s}`) };
      } finally { clearTimeout(timer); }
    },
  };
  ctx.items.declare(def);

  return {
    async start() {
      // Un serveur en panne n'empêche ni les autres ni le plugin (l'erreur est déjà journalisée).
      await Promise.allSettled(Object.keys(merged()).filter(isOn).map((id) => connOf(id).connect()));
    },
    async stop() { await Promise.all([...conns.values()].map((c) => c.disconnect())); },
  };
}
