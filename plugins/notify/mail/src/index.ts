// Plugin `notify-mail` : envoie les résultats de Floppy par mail (Gmail, Outlook, autre serveur SMTP).
// - Chaque destination ajoutée dans les réglages est offerte comme canal `notify` (un plugin qui veut notifier en choisit un).
// - Le mot de passe va dans le coffre des secrets (ctx.secrets), jamais dans un fichier ni dans les valeurs renvoyées.
// - Le texte Markdown part en HTML mis en forme, avec le Markdown lui-même comme version texte.
import { z } from "zod";
import nodemailer from "nodemailer";
import {
  definePlugin, errorText, itemSecret, T, TextError, tr, type FieldDef, type ItemInfo, type ItemKind, type OpResult, type PluginDef, type Text,
} from "@floppy/core";
import { mailHtml } from "./html.ts";

export { mailHtml } from "./html.ts";

const Config = z.object({
  timeout_s: z.number().default(15),
});
type Config = z.infer<typeof Config>;

/** Ce dont on a besoin d'un transporteur de mail (nodemailer, ou un faux dans les tests). */
export interface Transport {
  sendMail(msg: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
  verify(): Promise<unknown>;
  close?(): void;
}
export interface TransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}
export type TransportFactory = (opts: TransportOptions) => Transport;

const defaultFactory: TransportFactory = (opts) => nodemailer.createTransport(opts) as unknown as Transport;

type Fournisseur = "gmail" | "outlook" | "autre";
type Securite = "ssl" | "starttls";
interface Values {
  label: string;
  fournisseur: Fournisseur;
  adresse: string;
  destinataire: string;
  serveur: string;
  port: number;
  securite: Securite;
}
type Entry = Values & { id: string };

const PRESETS: Record<"gmail" | "outlook", { host: string; port: number; securite: Securite }> = {
  gmail: { host: "smtp.gmail.com", port: 465, securite: "ssl" },
  outlook: { host: "smtp-mail.outlook.com", port: 587, securite: "starttls" },
};
const NOMS: Record<Fournisseur, string> = { gmail: "Gmail", outlook: "Outlook", autre: "Mail" };

const FIELDS: FieldDef[] = [
  { key: "label", label: T("Nom", "Name"), type: "text", required: true, placeholder: T("Gmail perso", "Personal Gmail") },
  { key: "fournisseur", label: T("Fournisseur", "Provider"), type: "select", default: "gmail", options: [
    { value: "gmail", label: T("Gmail", "Gmail") },
    { value: "outlook", label: T("Outlook / Hotmail", "Outlook / Hotmail") },
    { value: "autre", label: T("Autre serveur", "Other server") },
  ] },
  { key: "adresse", label: T("Ton adresse mail", "Your email address"), type: "text", required: true, placeholder: T("moi@gmail.com", "me@gmail.com"),
    hint: T("Sert à te connecter et d'expéditeur.", "Used to log in and as sender.") },
  { key: "motdepasse", label: T("Mot de passe d'application", "App password"), type: "secret",
    hint: T(
      "Gmail demande un mot de passe d'application (Compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications). Ton vrai mot de passe ne marche pas.",
      "Gmail needs an app password (Google Account → Security → 2-Step Verification → App passwords). Your real password will not work.") },
  { key: "destinataire", label: T("Envoyer à", "Send to"), type: "text", placeholder: T("vide = la même adresse", "empty = same address"),
    hint: T("Laisse vide pour t'écrire à toi-même.", "Leave empty to write to yourself.") },
  { key: "serveur", label: T("Serveur SMTP", "SMTP server"), type: "text", advanced: true, placeholder: T("smtp.exemple.fr", "smtp.example.com"),
    showIf: { key: "fournisseur", values: ["autre"] } },
  { key: "port", label: T("Port", "Port"), type: "number", default: 465, advanced: true, min: 1, max: 65535,
    showIf: { key: "fournisseur", values: ["autre"] } },
  { key: "securite", label: T("Sécurité", "Security"), type: "select", default: "ssl", advanced: true,
    showIf: { key: "fournisseur", values: ["autre"] },
    options: [{ value: "ssl", label: T("SSL (port 465)", "SSL (port 465)") }, { value: "starttls", label: T("STARTTLS (port 587)", "STARTTLS (port 587)") }] },
];

const KIND: ItemKind = {
  id: "smtp",
  label: T("Boîte mail", "Mailbox"),
  // Montré en haut du formulaire « Ajouter ». Guide complet : docs/guide/notifications.md.
  description: T(
    "Gmail en 3 étapes :\n"
    + "1. Active la validation en deux étapes de ton compte Google (Compte Google → Sécurité).\n"
    + "2. Crée un mot de passe d'application : https://myaccount.google.com/apppasswords (nom : Floppy). Google affiche 16 lettres.\n"
    + "3. Mets ton adresse et ces 16 lettres ci-dessous, puis « Essayer » : Floppy vérifie la connexion, sans envoyer de mail.\n"
    + "Ce mot de passe ne sert qu'à envoyer des mails. Il est rangé dans le coffre de mots de passe du système. Tu peux le supprimer à tout moment sur la même page Google.",
    "Gmail in 3 steps:\n"
    + "1. Turn on 2-Step Verification on your Google account (Google Account → Security).\n"
    + "2. Create an app password: https://myaccount.google.com/apppasswords (name: Floppy). Google shows 16 letters.\n"
    + "3. Enter your address and these 16 letters below, then “Try”: Floppy checks the connection without sending an email.\n"
    + "This password only sends emails. It is kept in the system password vault. You can delete it anytime on the same Google page.",
  ),
  fields: FIELDS,
  cloud: true,
};

function clean(v: Record<string, unknown>): Values {
  const f = String(v.fournisseur ?? "gmail");
  const port = Number(v.port);
  return {
    label: String(v.label ?? "").trim(),
    fournisseur: f === "outlook" || f === "autre" ? f : "gmail",
    adresse: String(v.adresse ?? "").trim(),
    destinataire: String(v.destinataire ?? "").trim(),
    serveur: String(v.serveur ?? "").trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 465,
    securite: v.securite === "starttls" ? "starttls" : "ssl",
  };
}

/** Serveur réellement utilisé : le préréglage du fournisseur, ou les champs avancés. */
function serverOf(v: Values): { host: string; port: number; secure: boolean } {
  if (v.fournisseur === "autre") return { host: v.serveur, port: v.port, secure: v.securite === "ssl" };
  const p = PRESETS[v.fournisseur];
  return { host: p.host, port: p.port, secure: p.securite === "ssl" };
}

/** Message d'erreur en français et en anglais (sans jamais montrer le mot de passe). `message` reste en français. */
export function mailError(e: unknown): TextError {
  const x = e as { code?: string; responseCode?: number; message?: string } | undefined;
  const code = x?.code ?? "";
  if (code === "EAUTH" || x?.responseCode === 535) return new TextError(T("Mail : adresse ou mot de passe d'application refusé.", "Mail: address or app password refused."));
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH"].includes(code)) {
    return new TextError(T("Mail : serveur mail injoignable.", "Mail: mail server unreachable."));
  }
  if (code === "EENVELOPE") return new TextError(T("Mail : adresse du destinataire refusée.", "Mail: recipient address refused."));
  const msg = String(x?.message ?? e).split("\n")[0]!.slice(0, 160);
  return new TextError(T(`Mail : envoi impossible (${msg}).`, `Mail: cannot send (${msg}).`));
}

export function createMailPlugin(factory: TransportFactory = defaultFactory): PluginDef<Config> {
  return definePlugin<Config>({
    manifest: {
      id: "notify-mail",
      version: "0.1.0",
      licence: "MIT",
      sections: [
        { id: "notifications", label: T("Notifications", "Notifications"),
          description: T("Où Floppy peut envoyer des résultats : Telegram, mail…", "Where Floppy can send results: Telegram, email…") },
      ],
      description: "Notifications par mail (Gmail, Outlook, SMTP) : le texte Markdown part en mail HTML lisible.",
      provides: ["notify"],
      permissions: { net: ["*"], cloud: true },
      addable: { section: "notifications", label: T("Boîte mail", "Mailbox"), description: T("Gmail, Outlook ou un autre serveur : Floppy t'envoie ses résultats par mail.", "Gmail, Outlook or another server: Floppy emails you its results."), cloud: true, single: true },
    },
    config: Config,
    apply(ctx, cfg) {
      const store = ctx.items.store();
      const secret = itemSecret(ctx, (id) => `notify-mail/${id}/password`);
      const all = (): Entry[] => Object.entries(store.merge({}))
        .map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>), id }));
      const changed = () => ctx.items.changed();
      const ms = cfg.timeout_s * 1000;
      /** Langue de l'assistant : ce que Floppy écrit dans le mail (pied de page, mail de test). */
      const lang = () => ctx.assistant.language;

      const transportOf = (v: Values, pass: string): Transport => {
        const s = serverOf(v);
        return factory({ host: s.host, port: s.port, secure: s.secure, auth: { user: v.adresse, pass }, connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms * 2 });
      };

      /** Envoie un message avec les réglages donnés. */
      const sendWith = async (v: Values, pass: string | undefined, titre: string, markdown: string, signal?: AbortSignal) => {
        if (!pass) throw new TextError(T("Mail : pas de mot de passe d'application.", "Mail: no app password."));
        signal?.throwIfAborted();
        const t = transportOf(v, pass);
        try {
          await t.sendMail({ from: v.adresse, to: v.destinataire || v.adresse, subject: titre, html: mailHtml(titre, markdown, lang()), text: markdown });
        } catch (e) {
          throw mailError(e);
        } finally {
          try { t.close?.(); } catch { /* déjà fermé */ }
        }
      };

      ctx.offer("notify", {
        items: () => all().filter((m) => store.isEnabled(m.id)).map((m) => ({ id: m.id, label: m.label, cloud: true })),
        start(f, id) {
          const m = all().find((x) => x.id === id && store.isEnabled(x.id));
          if (!m) throw new TextError(T(`boîte mail inconnue ou désactivée : ${id}`, `unknown or disabled mailbox: ${id}`));
          f.provide("notify", {
            label: m.label, cloud: true,
            // On relit les réglages à chaque envoi : une modification est prise en compte tout de suite.
            send: async (msg, opts) => {
              const cur = all().find((x) => x.id === id);
              if (!cur) throw new TextError(T("Mail : cette boîte mail n'existe plus.", "Mail: this mailbox no longer exists."));
              await sendWith(cur, secret.get(id), msg.titre, msg.markdown, opts?.signal);
            },
          });
        },
      });

      const info = (m: Entry): ItemInfo => {
        const on = store.isEnabled(m.id);
        const hasPass = secret.has(m.id);
        return {
          id: m.id, label: m.label, kind: "smtp", enabled: on, cloud: true,
          detail: `${NOMS[m.fournisseur]} · ${m.adresse} → ${m.destinataire || m.adresse}`,
          status: !on ? "off" : hasPass ? "ok" : "warn",
          statusText: !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
            : hasPass ? undefined : T("pas de mot de passe d'application", "no app password"),
          values: { ...m, motdepasse: secret.shown(m.id) } as unknown as Record<string, unknown>,
          editable: true, removable: true, toggleable: true,
          actions: [{ id: "test-mail", label: T("Envoyer un mail de test", "Send a test email") }],
        };
      };


      const check = (v: Values): Text | undefined => {
        if (!v.label) return T("Il faut un nom.", "A name is required.");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.adresse)) return T("L'adresse mail n'est pas valide.", "The email address is not valid.");
        if (v.destinataire && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.destinataire)) return T("L'adresse du destinataire n'est pas valide.", "The recipient address is not valid.");
        if (v.fournisseur === "autre" && !v.serveur) return T("Il faut l'adresse du serveur SMTP.", "The SMTP server address is required.");
        return undefined;
      };

      ctx.items.declare({
        id: "notify-mail", section: "notifications", order: 20, offers: "notify",
        label: T("Mail", "Email"),
        description: T("Floppy t'envoie ses résultats par mail. Le texte quitte le PC.", "Floppy emails you its results. The text leaves this PC."),
        addLabel: T("Ajouter une boîte mail", "Add a mailbox"),
        badge: T("cloud", "cloud"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values): Promise<OpResult> => {
          if (kind !== "smtp") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
          const v = clean(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          const id = store.add("smtp", v as unknown as Record<string, unknown>, v.label, []);
          secret.apply(id, values.motdepasse);
          changed();
          return { ok: true, id, text: T(`${v.label} ajouté.`, `${v.label} added.`) };
        },
        update: async (id, values) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Boîte mail inconnue : ${id}`, `Unknown mailbox: ${id}`) };
          const v = clean({ ...cur, ...values });
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          store.update(id, v as unknown as Record<string, unknown>);
          secret.apply(id, values.motdepasse);
          changed();
          return { ok: true, id, text: T(`${v.label} modifié.`, `${v.label} updated.`) };
        },
        remove: async (id) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Boîte mail inconnue : ${id}`, `Unknown mailbox: ${id}`) };
          store.remove(id);
          secret.remove(id);
          changed();
          return { ok: true, text: T(`${cur.label} supprimé.`, `${cur.label} removed.`) };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Boîte mail inconnue : ${id}`, `Unknown mailbox: ${id}`) };
          store.setEnabled(id, on);
          changed();
          return { ok: true, text: on ? T(`${cur.label} activé.`, `${cur.label} enabled.`) : T(`${cur.label} désactivé : Floppy ne le voit plus (rien n'est supprimé).`, `${cur.label} disabled: Floppy no longer sees it (nothing deleted).`) };
        },
        // Essayer : on se connecte au serveur et on se connecte au compte, sans envoyer de mail.
        test: async (_kind, values, id): Promise<OpResult> => {
          const v = clean(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          const typed = values.motdepasse;
          const pass = secret.typedOr(id, typed);
          if (!pass) return { ok: false, text: T("Il faut le mot de passe d'application.", "The app password is required.") };
          const t = transportOf(v, pass);
          try {
            await t.verify();
            return { ok: true, text: T("Connexion au serveur réussie.", "Connected to the server.") };
          } catch (e) {
            return { ok: false, text: mailError(e).text };
          } finally {
            try { t.close?.(); } catch { /* déjà fermé */ }
          }
        },
        action: async (id, action): Promise<OpResult> => {
          const cur = all().find((m) => m.id === id);
          if (!cur) return { ok: false, text: T(`Boîte mail inconnue : ${id}`, `Unknown mailbox: ${id}`) };
          if (action !== "test-mail") return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
          try {
            await sendWith(cur, secret.get(id),
              tr(T("Mail de test de Floppy", "Floppy test email"), lang()),
              tr(T("Bonjour !\n\nSi tu lis ce message, **Floppy sait t'écrire par mail**.", "Hello!\n\nIf you read this message, **Floppy can email you**."), lang()));
            const to = cur.destinataire || cur.adresse;
            return { ok: true, text: T(`Mail de test envoyé à ${to}.`, `Test email sent to ${to}.`) };
          } catch (e) {
            return { ok: false, text: errorText(e) };
          }
        },
      });
    },
  });
}

export default createMailPlugin();
