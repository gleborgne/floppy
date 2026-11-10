// Plugin `m365` : Microsoft 365 (mails, agenda, personnes, fichiers, Teams) par Microsoft Graph.
// C'est une « application » de la rubrique Connecteurs : l'utilisateur l'ajoute, puis clique « Se connecter »
// (code d'appareil, voir graph.ts). Outils en LECTURE, sauf quatre en écriture (niveau write = carte d'accord) :
// ajouter un rendez-vous, ajouter un rappel, envoyer un message Teams, publier dans un canal Teams.
// Rien n'est supprimé ni déplacé. Le contenu des mails et des messages est une donnée, jamais une consigne.
import { z } from "zod";
import { definePlugin, errorText, tr, type Context, type Text, type ToolDef } from "@floppy/core";
import { MICROSOFT } from "./logo.ts";
import { CHANNEL_READ, GraphAuth, NotConnected, SCOPES, type TokenStore } from "./graph.ts";
import { teamsTools } from "./teams.ts";
import { mailSearchTools } from "./mail-search.ts";
import { calendarTools } from "./calendar.ts";
import { unreadMailTool } from "./unread-mail.ts";
import { BRIEF_ITEMS, calendarSection, mailSection } from "./brief.ts";
import { DATA, norm, t, when, plain, wrap } from "./util.ts";

export { GraphAuth, NotConnected } from "./graph.ts";
export { when, plain } from "./util.ts";

export const Config = z.object({
  /** Nombre maximum d'éléments rendus par un outil. */
  max: z.number().min(1).max(25).default(8),
});
type Config = z.infer<typeof Config>;

const who = (f?: { emailAddress?: { name?: string; address?: string } }) => f?.emailAddress?.name || f?.emailAddress?.address || "?";

/** « 2026-11-06T10:00 » (heure locale) → Date. Accepte aussi « 2026-11-06 10:00 ». */
export function localDate(raw: unknown): Date | undefined {
  const s = String(raw ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return undefined;
  const d = new Date(s.slice(0, 16));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const utc = (d: Date) => ({ dateTime: d.toISOString().slice(0, 19), timeZone: "UTC" });
const fmt = (d: Date) => `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
/** Même date en anglais (carte d'accord) : « Thursday, November 5 at 15:00 ». */
const fmtEn = (d: Date) => `${d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })} at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

export function m365Tools(g: GraphAuth, cfg: Config): ToolDef[] {
  /** Noms lisibles des destinataires (adresse, id de conversation, canal) pour les cartes d'accord. */
  const labels = new Map<string, Text>();

  return [
    unreadMailTool(g, cfg.max),
    ...mailSearchTools(g, cfg.max),
    {
      name: "m365_read_mail",
      description: "Lit un mail Outlook complet (expéditeur, destinataires, date, texte). id : l'id donné par m365_unread_mail ou m365_search_mail.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      level: "read",
      handler: wrap(async (a) => {
        const id = encodeURIComponent(String(a.id ?? ""));
        const m = await g.get<any>(`me/messages/${id}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink`);
        const to = (m.toRecipients ?? []).map(who).join(", ");
        return `De : ${who(m.from)}\nÀ : ${to}\nDate : ${when(m.receivedDateTime)}\nObjet : ${m.subject}\nLien : ${m.webLink ?? ""}\n${DATA}\n---\n${plain(String(m.body?.content ?? ""))}`;
      }),
    },
    ...calendarTools(g, cfg.max),
    {
      name: "m365_search_people",
      description: "Cherche une personne (collègue, contact) dans Microsoft 365 : nom, adresse mail, poste. name : le nom ou le prénom. L'adresse sert à m365_send_teams_message.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      level: "read",
      handler: wrap(async (a) => {
        const q = String(a.name ?? "").replace(/"/g, " ").trim();
        const r = await g.get<{ value: any[] }>(`me/people?$search="${encodeURIComponent(q)}"&$top=5&$select=displayName,scoredEmailAddresses,jobTitle,department`);
        for (const p of r.value) { const m = p.scoredEmailAddresses?.[0]?.address; if (m) labels.set(norm(m), p.displayName); }
        return r.value.length ? r.value.map((p) => `- ${p.displayName}${p.jobTitle ? `, ${p.jobTitle}` : ""}${p.department ? ` (${p.department})` : ""} — ${p.scoredEmailAddresses?.[0]?.address ?? ""}`).join("\n") + `\n${DATA}` : `Personne trouvée pour « ${q} » : aucune.`;
      }),
    },
    {
      name: "m365_search_files",
      description: "Cherche des fichiers dans OneDrive et SharePoint (Microsoft 365) par mots. query : les mots. Rend le nom, la date et le lien.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      level: "read",
      handler: wrap(async (a) => {
        const q = String(a.query ?? "").trim();
        const r = await g.call<any>("POST", "search/query", { requests: [{ entityTypes: ["driveItem"], query: { queryString: q }, from: 0, size: cfg.max }] });
        const hits = (r.value?.[0]?.hitsContainers?.[0]?.hits ?? []) as any[];
        return hits.length ? hits.map((h, i) => `${i + 1}. ${h.resource?.name} — modifié ${when(h.resource?.lastModifiedDateTime)} — ${h.resource?.webUrl}`).join("\n") + `\n${DATA}` : `Aucun fichier trouvé pour « ${q} ».`;
      }),
    },
    {
      name: "m365_add_meeting",
      description: "Ajoute un rendez-vous dans l'agenda Outlook de l'utilisateur (sans inviter personne). L'utilisateur voit la demande et accepte. title ; start : date et heure locales AAAA-MM-JJTHH:MM ; duration_min (défaut 30) ; location (facultatif) ; reminder_min : minutes avant pour la notification (défaut 15) ; notes (facultatif).",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, start: { type: "string" }, duration_min: { type: "number" }, location: { type: "string" }, reminder_min: { type: "number" }, notes: { type: "string" } },
        required: ["title", "start"],
      },
      level: "write",
      summary: (a) => {
        const d = localDate(a.start);
        const title = String(a.title ?? "").slice(0, 80);
        const rest = `(${Number(a.duration_min) || 30} min)${a.location ? `, ${String(a.location).slice(0, 60)}` : ""}`;
        return t(
          `Ajouter à ton agenda : « ${title} »${d ? `, ${fmt(d)}` : ""} ${rest}`,
          `Add to your calendar: “${title}”${d ? `, ${fmtEn(d)}` : ""} ${rest}`,
        );
      },
      handler: wrap(async (a) => {
        const start = localDate(a.start);
        if (!start) return Promise.reject(new Error("start : il faut une date et une heure, au format AAAA-MM-JJTHH:MM."));
        const mins = Math.max(5, Math.min(24 * 60, Number(a.duration_min) || 30));
        const end = new Date(start.getTime() + mins * 60000);
        const e = await g.call<any>("POST", "me/events", {
          subject: String(a.title ?? "").slice(0, 255), start: utc(start), end: utc(end),
          ...(a.location ? { location: { displayName: String(a.location).slice(0, 255) } } : {}),
          ...(a.notes ? { body: { contentType: "text", content: String(a.notes).slice(0, 4000) } } : {}),
          isReminderOn: true, reminderMinutesBeforeStart: Math.max(0, Math.min(10080, Number(a.reminder_min ?? 15))),
          showAs: "busy",
        });
        return `Ajouté à l'agenda : « ${e.subject} », ${fmt(start)} (${mins} min).`;
      }),
    },
    {
      name: "m365_add_reminder",
      description: "Ajoute un rappel dans l'agenda Outlook : une notification à l'heure dite (créneau court marqué « libre », personne n'est invité). Pour « rappelle-moi de… à… ». L'utilisateur voit la demande et accepte. text : de quoi se souvenir ; when : date et heure locales AAAA-MM-JJTHH:MM.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, when: { type: "string" } }, required: ["text", "when"] },
      level: "write",
      summary: (a) => {
        const d = localDate(a.when);
        const what = String(a.text ?? "").slice(0, 80);
        return t(`Rappel dans ton agenda : « ${what} »${d ? `, ${fmt(d)}` : ""}`, `Reminder in your calendar: “${what}”${d ? `, ${fmtEn(d)}` : ""}`);
      },
      handler: wrap(async (a) => {
        const at = localDate(a.when);
        if (!at) return Promise.reject(new Error("when : il faut une date et une heure, au format AAAA-MM-JJTHH:MM."));
        if (at.getTime() < Date.now() - 60000) return Promise.reject(new Error("cette heure est déjà passée"));
        await g.call<any>("POST", "me/events", {
          subject: `Rappel : ${String(a.text ?? "").slice(0, 240)}`, start: utc(at), end: utc(new Date(at.getTime() + 15 * 60000)),
          isReminderOn: true, reminderMinutesBeforeStart: 0, showAs: "free", categories: ["Floppy"],
        });
        return `Rappel ajouté : « ${String(a.text)} », ${fmt(at)}.`;
      }),
    },
    ...teamsTools(g, cfg.max, labels),
  ];
}

/** `fetchImpl` : faux réseau des tests ; sinon le `ctx.fetch` du plugin. */
export function createM365Plugin(fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return definePlugin<Config>({
    manifest: {
      id: "m365",
      version: "0.1.0",
      licence: "MIT",
      sections: [
        { id: "connectors", label: { fr: "Connecteurs", en: "Connectors" } },
      ],
      description: "Microsoft 365 (mails, agenda, personnes, fichiers, Teams) par Microsoft Graph : lecture, ajout dans l'agenda, envoi de messages Teams.",
      // Connexion par code d'appareil (login.microsoftonline.com) puis Microsoft Graph.
      permissions: { net: ["login.microsoftonline.com", "graph.microsoft.com"] },
      // brief : l'agenda du jour et les mails non lus, rubriques du point du matin.
      provides: ["brief"],
      addable: {
        section: "connectors",
        single: true,
        cloud: true,
        logo: MICROSOFT,
        label: "Microsoft 365",
        description: t("Mails, agenda, personnes, fichiers et Teams par Microsoft Graph. Lecture, plus ajout de rendez-vous et de rappels, envoi de messages Teams (toujours avec ton accord). Connexion par code.", "Mail, calendar, people, files and Teams through Microsoft Graph. Read, plus adding meetings and reminders and sending Teams messages (always with your approval). Sign-in with a code."),
        aliases: ["microsoft 365", "office 365", "outlook", "office"],
        fields: [{ key: "max", label: t("Nombre d'éléments par réponse", "Items per answer"), type: "number", default: 8, min: 1, max: 25, advanced: true }],
      },
    },
    config: Config,
    apply(ctx: Context, cfg) {
      const name = `m365/${ctx.id}/refresh`;
      const store: TokenStore = {
        get: () => ctx.secrets.get(name),
        set: (v) => ctx.secrets.set(name, v),
        clear: () => ctx.secrets.delete(name),
      };
      const g = new GraphAuth(store, fetchImpl ?? ctx.fetch);
      ctx.tools.register(m365Tools(g, cfg));
      ctx.offer("brief", {
        items: () => BRIEF_ITEMS,
        start(f, item) {
          f.provide("brief", { collect: (req) => (item === "calendar" ? calendarSection(g, req) : mailSection(g, req)) });
        },
      });

      let pending: AbortController | undefined;
      /** Permissions de base pas encore accordées (connexion faite avant l'ajout d'une fonction). */
      let missing: string[] = [];
      const show = () => {
        if (pending) return;
        if (!g.connected) ctx.items.status(t("pas connecté : clique « Se connecter »", "not signed in: click “Sign in”"), "warn");
        else if (missing.length) ctx.items.status(t(`connecté${g.who ? ` : ${g.who}` : ""} — reconnecte-toi pour activer les nouvelles fonctions Teams`, `signed in${g.who ? `: ${g.who}` : ""} — sign in again to enable the new Teams features`), "warn");
        else ctx.items.status(g.who ? t(`connecté : ${g.who}`, `signed in: ${g.who}`) : t("connecté", "signed in"));
      };
      const refresh = async () => {
        try {
          await g.me();
          missing = await g.missing(SCOPES.split(" "));
        } catch (e) {
          if (!(e instanceof NotConnected)) return;
        }
        show();
      };
      ctx.effect(() => pending?.abort());
      if (g.connected) void refresh();
      show();

      ctx.items.actions(
        [
          { id: "login", label: t("Se connecter", "Sign in") },
          { id: "channels", label: t("Autoriser les canaux", "Allow channels") },
          { id: "logout", label: t("Se déconnecter", "Sign out") },
        ],
        async (action) => {
          if (action === "logout") {
            pending?.abort(); pending = undefined;
            g.logout();
            show();
            ctx.audit.write({ kind: "m365.logout" });
            return { ok: true, text: t("Déconnecté de Microsoft 365.", "Signed out of Microsoft 365.") };
          }
          pending?.abort();
          const ac = new AbortController();
          pending = ac;
          // « Autoriser les canaux » = la même connexion, plus la lecture des canaux (accord d'un administrateur).
          const channels = action === "channels";
          const dc = await g.start(ac.signal, channels ? CHANNEL_READ : "");
          ctx.items.status(t(`connexion : tape le code ${dc.userCode} sur ${dc.url}`, `sign-in: enter code ${dc.userCode} at ${dc.url}`), "warn");
          void dc.poll().catch((e: unknown): { ok: boolean; text: Text } => ({ ok: false, text: errorText(e) })).then((r) => {
            if (pending !== ac) return;
            pending = undefined;
            ctx.audit.write({ kind: "m365.login", ok: r.ok, ...(channels ? { channels: true } : {}) });
            if (!r.ok) {
              const admin = channels && /admin|AADSTS90094|AADSTS65001/i.test(tr(r.text));
              ctx.items.status(admin
                ? t("lecture des canaux refusée : un administrateur Microsoft doit l'approuver (le reste marche)", "channel reading refused: a Microsoft admin must approve it (everything else works)")
                : t(`connexion ratée : ${tr(r.text, "fr")}`, `sign-in failed: ${tr(r.text, "en")}`), "error");
            } else void refresh();
          });
          return {
            ok: true, open: dc.url, copy: dc.userCode,
            text: t(
              `La page Microsoft s'ouvre dans ton navigateur. Colle le code ${dc.userCode} (déjà copié), puis connecte-toi avec ton compte de travail.${channels ? " Microsoft peut demander l'accord d'un administrateur pour lire les canaux d'équipe." : ""} Valable ${Math.round(dc.expiresIn / 60)} min.`,
              `The Microsoft page opens in your browser. Paste the code ${dc.userCode} (already copied), then sign in with your work account.${channels ? " Microsoft may ask for an admin's approval to read team channels." : ""} Valid for ${Math.round(dc.expiresIn / 60)} min.`,
            ),
          };
        },
      );
    },
  });
}

export default createM365Plugin();
