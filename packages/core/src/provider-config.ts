import type { ZodType } from "zod";
import { SECRET_SET, type FieldDef } from "./catalog.ts";
import type { Context } from "./plugin/context.ts";
import type { Availability } from "./services.ts";
import { T, TextError, tr, type Text } from "./i18n.ts";

/** Un compte fournisseur : configuration non secrète dans le catalogue, clé dans le coffre. */
export function providerConfig<C extends Record<string, unknown>>(ctx: Context, opts: {
  schema: ZodType<C>; base: C; fields: FieldDef[]; label: Text; section: string; capabilities?: string[];
  /** Configuration incomplète : la raison (texte simple ou { fr, en }), sinon undefined. */
  validate?(config: C): Text | undefined;
  /** Service que le compte offre (ctx.offer, élément « account ») : la fenêtre met « Activer » sur le compte. */
  offers?: string;
  /** Certains fournisseurs locaux n'ont aucun secret. Les autres gardent apiKey dans le coffre. */
  secret?: false; secretLabel?: Text; onChange?(): void;
  /** Ligne sous le nom de l'élément (ex. le dernier mot d'activation entendu). */
  detail?(): Text | undefined;
}): { config(): C; apiKey(): string; availability(): Availability } {
  const store = ctx.items.store();
  const secret = `${ctx.plugin}/${ctx.id}/apiKey`;
  const config = () => opts.schema.parse(store.merge({ account: opts.base }).account);
  const missingKey = (): Text => T(`Clé API manquante pour ${tr(opts.label, "fr")} : ouvre les réglages.`, `API key missing for ${tr(opts.label, "en")}: open the settings.`);
  const why = (): Text | undefined => (opts.secret !== false && !ctx.secrets.has(secret) ? missingKey() : opts.validate?.(config()));
  const availability = (): Availability => {
    const reason = why();
    // `reason` reste une chaîne (dite ou levée par les plugins) ; `reasonText` garde les deux langues.
    return reason ? { ready: false, reason: tr(reason, ctx.assistant.language), reasonText: reason } : { ready: true };
  };
  const keyField: FieldDef = { key: "apiKey", label: opts.secretLabel ?? { fr: "Clé API", en: "API key" }, type: "secret" };
  ctx.items.declare({
    id: `${ctx.id}-account`, section: opts.section, label: opts.label, capabilities: opts.capabilities, ...(opts.offers ? { offers: opts.offers } : {}),
    kinds: [{ id: "account", label: opts.label, cloud: opts.secret !== false, fields: [...opts.fields, ...(opts.secret === false ? [] : [keyField])] }],
    list: () => {
      const reason = why();
      const detail = opts.detail?.();
      return [{
        id: "account", kind: "account", label: opts.label, ...(detail ? { detail } : {}), enabled: true, cloud: opts.secret !== false, editable: true,
        status: reason ? "warn" : "ok",
        statusText: reason,
        values: { ...config(), ...(opts.secret === false ? {} : { apiKey: ctx.secrets.has(secret) ? SECRET_SET : "" }) },
      }];
    },
    update: async (id, values) => {
      if (id !== "account") return { ok: false, text: T("Compte inconnu.", "Unknown account.") };
      const { apiKey, ...rest } = values;
      const parsed = opts.schema.safeParse({ ...config(), ...rest });
      if (!parsed.success) return { ok: false, text: parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ") };
      if (opts.secret !== false && apiKey !== undefined && apiKey !== SECRET_SET) {
        const value = String(apiKey).trim();
        if (value) ctx.secrets.set(secret, value); else ctx.secrets.delete(secret);
      }
      store.update("account", parsed.data);
      opts.onChange?.();
      ctx.items.changed();
      return { ok: true, text: T(`${tr(opts.label, "fr")} enregistré. Les nouvelles sessions utiliseront ces réglages.`, `${tr(opts.label, "en")} saved. New sessions will use these settings.`) };
    },
  });
  return { config, availability, apiKey: () => {
    const value = ctx.secrets.get(secret);
    if (!value) throw new TextError(missingKey());
    return value;
  } };
}

/**
 * Le secret de chaque élément d'une liste (une clé d'API par modèle distant, un mot de passe par boîte mail…),
 * rangé dans le coffre sous `name(id)`. Une seule règle pour le formulaire : la fenêtre montre SECRET_SET quand
 * le secret existe ; SECRET_SET ou rien = inchangé, vide = effacé, sinon gardé.
 */
export interface ItemSecret {
  has(id: string): boolean;
  get(id: string): string | undefined;
  /** Valeur montrée dans le formulaire : SECRET_SET si le secret existe, sinon vide. */
  shown(id: string): string;
  /** Applique la valeur du formulaire. */
  apply(id: string, value: unknown): void;
  /** Bouton « Tester » : la valeur tapée, sinon celle du coffre (élément déjà enregistré). */
  typedOr(id: string | undefined, typed: unknown): string | undefined;
  remove(id: string): void;
}

export function itemSecret(ctx: Pick<Context, "secrets">, name: (id: string) => string): ItemSecret {
  const s = ctx.secrets;
  return {
    has: (id) => s.has(name(id)),
    get: (id) => s.get(name(id)),
    shown: (id) => (s.has(name(id)) ? SECRET_SET : ""),
    apply(id, value) {
      if (value === undefined || value === SECRET_SET) return;
      const v = String(value).trim();
      if (v) s.set(name(id), v); else s.delete(name(id));
    },
    typedOr: (id, typed) => (typed === undefined || typed === SECRET_SET ? (id ? s.get(name(id)) : undefined) : String(typed).trim() || undefined),
    remove: (id) => s.delete(name(id)),
  };
}
