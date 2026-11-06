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
      return [{
        id: "account", kind: "account", label: opts.label, enabled: true, cloud: opts.secret !== false, editable: true,
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
