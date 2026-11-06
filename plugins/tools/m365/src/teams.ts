// Outils Teams du plugin m365 : conversations (privées et de groupe), canaux d'équipe, présence, envoi.
//
// Parcours visés (utilisateur à son ordinateur) :
//  - « J'ai des messages Teams non lus ? »                 → m365_teams_non_lus
//  - « Qu'est-ce que Florent m'a envoyé ? » / « on parlait de quoi avec Florent ? » → m365_messages_teams
//  - « Lis-moi la conversation du groupe Projet Voix »     → m365_conversations_teams puis m365_lire_conversation_teams
//  - « Quoi de neuf dans le canal Général de Marketing ? » → m365_messages_canal (m365_canaux_teams pour la liste)
//  - « Florent est dispo ? »                               → m365_presence
//  - « Envoie un message à Florent pour lui demander… »    → m365_envoyer_message_teams (carte d'accord)
//  - « Réponds dans le canal / dans ce fil »              → m365_publier_canal (carte d'accord)
//
// Envoi : le destinataire est TOUJOURS une adresse ou un id précis, jamais un prénom deviné. La carte d'accord
// montre le nom complet, l'adresse et le texte exact. Les canaux se lisent seulement si un administrateur
// Microsoft a approuvé la permission ChannelMessage.Read.All (bouton « Autoriser les canaux »).
import { T, tr, type Text, type ToolDef } from "@floppy/core";
import { CHANNEL_READ, Forbidden, GRAPH, NotConnected, RELOGIN, type GraphAuth } from "./graph.ts";
import { DATA, clamp, norm, plain, toHtml, when, wrap } from "./util.ts";

export const CHANNEL_HINT = "La lecture des canaux d'équipe demande l'accord d'un administrateur Microsoft. Dis à l'utilisateur de cliquer « Autoriser les canaux » sur Microsoft 365 (Réglages → Connecteurs). Si Microsoft demande un administrateur, son service informatique doit approuver l'application « Microsoft Graph Command Line Tools ». Les discussions privées et de groupe, elles, marchent déjà.";

const PRESENCE: Record<string, string> = {
  Available: "disponible", AvailableIdle: "disponible (inactif)", Busy: "occupé", BusyIdle: "occupé (inactif)",
  DoNotDisturb: "ne pas déranger", BeRightBack: "revient bientôt", Away: "absent", Offline: "hors ligne", PresenceUnknown: "inconnue",
};
const ACTIVITY: Record<string, string> = {
  InACall: "en appel", InAConferenceCall: "en conférence", InAMeeting: "en réunion", Presenting: "en présentation",
  UrgentInterruptionsOnly: "interruptions urgentes seulement", OutOfOffice: "absent du bureau",
};
const EMAIL = /^[^\s@:]+@[^\s@]+\.[^\s@]+$/;
const enc = encodeURIComponent;

// Les textes rendus au cerveau restent en français ; seules les cartes d'accord (lues par l'utilisateur) sont bilingues.
export function teamsTools(g: GraphAuth, max: number, labels: Map<string, Text>): ToolDef[] {
  const n = (v: unknown, def = max) => clamp(v, def, 1, 25);
  let myId: string | undefined;
  const meId = async () => (myId ??= (await g.get<{ id: string }>("me?$select=id")).id);
  /** Refuse tout de suite, avec la marche à suivre, si la permission n'a pas été accordée. */
  const need = async (scope: string, hint = RELOGIN) => {
    if ((await g.missing([scope])).length) throw new Error(`Permission Microsoft manquante (${scope}). ${hint}`);
  };

  // --- Conversations (chats)
  const lastAt = (c: any) => Date.parse(c.lastMessagePreview?.createdDateTime ?? c.lastUpdatedDateTime ?? "") || 0;
  const others = (c: any, me: string) => (c.members ?? []).filter((m: any) => m.userId !== me) as any[];
  const chatNameT = (c: any, me: string): Text => {
    const o = others(c, me);
    if (c.chatType === "oneOnOne") { const who = o[0]?.displayName ?? "?"; return T(`Discussion privée avec ${who}`, `Private chat with ${who}`); }
    const names = o.slice(0, 4).map((m) => String(m.displayName ?? "?").split(" ")[0]).join(", ") + (o.length > 4 ? "…" : "");
    return c.topic ? T(`Groupe « ${c.topic} » (${names})`, `Group “${c.topic}” (${names})`) : T(`Groupe avec ${names}`, `Group with ${names}`);
  };
  /** Nom d'une conversation pour le cerveau (français). */
  const chatName = (c: any, me: string) => tr(chatNameT(c, me), "fr");
  const channelLabel = (ch: string, team: string): Text => T(`canal « ${ch} » de l'équipe « ${team} »`, `channel “${ch}” of team “${team}”`);
  /** Les 50 conversations les plus récentes, avec leurs membres. Retient les noms pour les cartes d'accord. */
  const chats = async (): Promise<any[]> => {
    let r: { value: any[] };
    try {
      r = await g.get(`me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50`);
    } catch (e) {
      if (e instanceof NotConnected) throw e;
      r = await g.get(`me/chats?$expand=members&$top=50`); // repli si Graph refuse la double expansion
    }
    const me = await meId();
    for (const c of r.value) {
      labels.set(c.id, chatNameT(c, me));
      for (const m of c.members ?? []) if (m.email && m.userId !== me) labels.set(norm(m.email), m.displayName);
    }
    return r.value.sort((a, b) => lastAt(b) - lastAt(a));
  };
  const unread = (c: any, me: string) => {
    const last = c.lastMessagePreview, read = c.viewpoint?.lastMessageReadDateTime;
    if (!last || !read || c.viewpoint?.isHidden || last.from?.user?.id === me) return false;
    return Date.parse(last.createdDateTime) > Date.parse(read);
  };
  /** Messages d'une conversation depuis `since` (les 50 plus récents au plus), du plus récent au plus ancien. */
  const chatMessages = async (chatId: string, since: number) => {
    const r = await g.get<{ value: any[] }>(`chats/${enc(chatId)}/messages?$top=50&$orderby=createdDateTime desc`);
    return r.value.filter((m) => m.messageType === "message" && !m.deletedDateTime && Date.parse(m.createdDateTime) >= since);
  };
  const msgText = (m: any, size = 400) => {
    const text = plain(String(m.body?.content ?? ""), size);
    const files = (m.attachments ?? []).map((x: any) => x.name).filter(Boolean);
    return (text + (files.length ? ` (pièce jointe : ${files.join(", ")})` : "")).trim() || "(sans texte)";
  };
  const author = (m: any, me: string) => (m.from?.user?.id === me ? "moi" : m.from?.user?.displayName ?? m.from?.application?.displayName ?? "?");
  const mentionsMe = (m: any, me: string) => (m.mentions ?? []).some((x: any) => x.mentioned?.user?.id === me);
  const msgLine = (m: any, me: string) => `- ${when(m.createdDateTime)} — ${author(m, me)} : « ${msgText(m)} »${mentionsMe(m, me) ? " (te mentionne)" : ""}`;

  // --- Équipes et canaux
  const joinedTeams = async () => {
    await need("Team.ReadBasic.All");
    return (await g.get<{ value: any[] }>("me/joinedTeams?$select=id,displayName")).value;
  };
  const channelsOf = async (teamId: string) => {
    await need("Channel.ReadBasic.All");
    return (await g.get<{ value: any[] }>(`teams/${enc(teamId)}/channels?$select=id,displayName,membershipType`)).value;
  };
  const pick = (list: any[], q: string) => {
    const w = norm(q).split(/\s+/).filter(Boolean);
    return list.find((x) => x.id === q) ?? list.find((x) => norm(x.displayName) === norm(q)) ?? list.find((x) => w.every((y) => norm(x.displayName).includes(y)));
  };
  const findChannel = async (equipe: string, canal: string) => {
    const ts = await joinedTeams();
    const team = pick(ts, equipe);
    if (!team) throw new Error(`Équipe « ${equipe} » introuvable. Tes équipes : ${ts.map((x) => x.displayName).join(", ") || "aucune"}.`);
    const cs = await channelsOf(team.id);
    const ch = canal ? pick(cs, canal) : cs.find((x) => norm(x.displayName) === "general") ?? cs[0];
    if (!ch) throw new Error(`Canal « ${canal} » introuvable dans « ${team.displayName} ». Canaux : ${cs.map((x) => x.displayName).join(", ")}.`);
    labels.set(`${team.id}|${ch.id}`, channelLabel(ch.displayName, team.displayName));
    return { team, ch };
  };

  // --- Personnes
  /** Nom ou adresse → { id, nom, adresse } d'un collègue. Lecture seulement : peut prendre le premier trouvé. */
  const person = async (q: string) => {
    let email = EMAIL.test(q) ? q : undefined;
    if (!email) {
      const r = await g.get<{ value: any[] }>(`me/people?$search="${enc(q.replace(/"/g, " "))}"&$top=1&$select=displayName,scoredEmailAddresses`);
      email = r.value[0]?.scoredEmailAddresses?.[0]?.address;
      if (!email) throw new Error(`Personne trouvée pour « ${q} » : aucune.`);
    }
    await need("User.ReadBasic.All");
    const u = await g.get<{ id: string; displayName?: string; mail?: string }>(`users/${enc(email)}?$select=id,displayName,mail`);
    return { id: u.id, name: u.displayName ?? email, email: u.mail ?? email };
  };

  /** Libellé d'un destinataire pour la carte d'accord : nom connu, sinon le nom donné par le cerveau. */
  const destLabel = (dest: string, nom: unknown): Text => {
    if (EMAIL.test(dest)) { const who = labels.get(norm(dest)) ?? (String(nom ?? "").trim() || "?"); return T(`${tr(who, "fr")} (${dest})`, `${tr(who, "en")} (${dest})`); }
    const n = String(nom ?? "").trim();
    return labels.get(dest) ?? (n ? T(`la conversation « ${n} »`, `the chat “${n}”`) : T("une conversation Teams", "a Teams chat"));
  };
  const quote = (s: unknown) => { const x = String(s ?? "").trim(); return x.length > 400 ? x.slice(0, 399) + "…" : x; };

  return [
    {
      name: "m365_conversations_teams",
      description: "Dernières conversations Teams (discussions privées et de groupe) : avec qui, le dernier message, la date, « non lu », et l'id pour m365_lire_conversation_teams ou m365_envoyer_message_teams. max : nombre (défaut 8). Pour les messages d'une personne précise, utilise plutôt m365_messages_teams.",
      inputSchema: { type: "object", properties: { max: { type: "number" } } },
      level: "read",
      handler: wrap(async (a) => {
        const [me, all] = await Promise.all([meId(), chats()]);
        if (!all.length) return "Aucune conversation Teams.";
        return `${all.slice(0, n(a.max)).map((c, i) => {
          const m = c.lastMessagePreview;
          const from = m?.from ? author(m, me) : "";
          const text = m?.body?.content ? plain(String(m.body.content), 160) : "";
          return `${i + 1}. ${chatName(c, me)}${unread(c, me) ? " (non lu)" : ""}${from ? ` — ${from}` : ""}${text ? ` : « ${text} »` : ""}${m?.createdDateTime ? ` — ${when(m.createdDateTime)}` : ""} [id ${c.id}]`;
        }).join("\n")}\n${DATA}`;
      }),
    },
    {
      name: "m365_teams_non_lus",
      description: "Messages Teams non lus dans les discussions privées et de groupe : qui, quoi, quand, et l'id de la conversation pour répondre. max : nombre de conversations (défaut 5).",
      inputSchema: { type: "object", properties: { max: { type: "number" } } },
      level: "read",
      handler: wrap(async (a) => {
        const [me, all] = await Promise.all([meId(), chats()]);
        if (!all.some((c) => c.viewpoint)) return "Teams ne dit pas ici ce qui est lu ou non. Utilise m365_conversations_teams pour les dernières conversations.";
        const list = all.filter((c) => unread(c, me));
        if (!list.length) return "Aucun message Teams non lu dans tes conversations.";
        const top = list.slice(0, n(a.max, 5));
        const msgs = await Promise.all(top.map((c) => chatMessages(c.id, Date.parse(c.viewpoint.lastMessageReadDateTime) + 1).catch(() => [] as any[])));
        const parts = top.map((c, i) => {
          const m = msgs[i]!.filter((x) => x.from?.user?.id !== me);
          const shown = m.slice(0, 10).reverse();
          return `${chatName(c, me)} — ${m.length || "?"} non lu(s) [id ${c.id}] :\n${shown.length ? shown.map((x) => msgLine(x, me)).join("\n") : `- « ${plain(String(c.lastMessagePreview?.body?.content ?? ""), 300)} »`}`;
        });
        return `${list.length} conversation(s) avec des messages non lus :\n${parts.join("\n\n")}${list.length > top.length ? `\n(et ${list.length - top.length} autre(s))` : ""}\n${DATA}`;
      }),
    },
    {
      name: "m365_messages_teams",
      description: "Messages Teams échangés avec une personne (discussion privée et groupes où elle est), dans l'ordre, avec date et auteur (« moi » = l'utilisateur). Rend aussi son adresse et l'id de la discussion privée (pour lui répondre). personne : nom ou prénom. seulement_lui : true pour ne garder que les messages envoyés par cette personne (« les derniers messages que Florent m'a envoyés ») ; false (défaut) pour les deux côtés (« on parlait de quoi avec Florent ? » : résume alors les sujets). jours : période (défaut 14, 90 au plus). contient : mots à trouver dans le texte (facultatif). max : nombre de messages (défaut 20, 50 au plus).",
      inputSchema: {
        type: "object",
        properties: { personne: { type: "string" }, seulement_lui: { type: "boolean" }, jours: { type: "number" }, contient: { type: "string" }, max: { type: "number" } },
        required: ["personne"],
      },
      level: "read",
      handler: wrap(async (a) => {
        const words = norm(a.personne).split(/\s+/).filter(Boolean);
        if (!words.length) return "personne : il faut un nom.";
        const days = clamp(a.jours, 14, 1, 90);
        const since = Date.now() - days * 864e5;
        const [me, all] = await Promise.all([meId(), chats()]);
        const hit = (m: any) => m.userId !== me && words.every((w) => norm(m.displayName).includes(w) || norm(m.email).includes(w));
        // Personnes trouvées, de la plus récente à la plus ancienne.
        const people = new Map<string, { name: string; email?: string }>();
        for (const c of all) for (const m of (c.members ?? []).filter(hit)) if (!people.has(m.userId)) people.set(m.userId, { name: m.displayName, email: m.email });
        if (!people.size) return `Aucune conversation Teams récente avec « ${a.personne} ». Vérifie le nom avec m365_chercher_personnes.`;
        const [pid, p] = [...people][0]!;
        const note = people.size > 1 ? `\n(Plusieurs personnes correspondent : ${[...people.values()].map((x) => x.name).join(", ")}. J'ai pris ${p.name}, la plus récente. Redemande avec le nom complet pour une autre.)` : "";
        // Discussion privée d'abord, puis les groupes actifs sur la période ; 5 conversations au plus.
        const picked = all
          .filter((c) => c.members?.some((m: any) => m.userId === pid) && (c.chatType === "oneOnOne" || !lastAt(c) || lastAt(c) >= since))
          .sort((x, y) => (x.chatType === "oneOnOne" ? 0 : 1) - (y.chatType === "oneOnOne" ? 0 : 1))
          .slice(0, 5);
        const direct = picked.find((c) => c.chatType === "oneOnOne");
        const ident = `${p.name}${p.email ? ` (${p.email})` : ""}${direct ? ` [discussion privée : id ${direct.id}]` : ""}`;
        const lists = await Promise.all(picked.map((c) => chatMessages(c.id, since).catch(() => [] as any[])));
        const must = norm(a.contient).split(/\s+/).filter(Boolean);
        let msgs = lists.flatMap((l, i) => l.map((m) => ({ m, c: i })))
          .filter(({ m }) => !a.seulement_lui || m.from?.user?.id === pid)
          .filter(({ m }) => must.every((w) => norm(msgText(m)).includes(w)));
        msgs.sort((x, y) => Date.parse(y.m.createdDateTime) - Date.parse(x.m.createdDateTime));
        msgs = msgs.slice(0, clamp(a.max, 20, 1, 50));
        const what = a.seulement_lui ? `envoyés par ${ident}` : `avec ${ident}`;
        if (!msgs.length) return `Aucun message Teams ${what}${must.length ? ` contenant « ${a.contient} »` : ""} sur les ${days} derniers jours.${note}`;
        const parts = picked.map((c, i) => {
          const mine = msgs.filter((x) => x.c === i).map((x) => x.m).reverse();
          return mine.length ? `${chatName(c, me)} :\n${mine.map((m) => msgLine(m, me)).join("\n")}` : "";
        }).filter(Boolean);
        return `Messages Teams ${what} (${days} derniers jours, ${msgs.length} message(s), du plus ancien au plus récent) :\n${parts.join("\n\n")}${note}\n${DATA}`;
      }),
    },
    {
      name: "m365_lire_conversation_teams",
      description: "Lit les derniers messages d'une conversation Teams (privée ou de groupe), dans l'ordre. id : l'id donné par m365_conversations_teams ou m365_teams_non_lus. jours : période (défaut 30, 90 au plus). max : nombre de messages (défaut 20, 50 au plus).",
      inputSchema: { type: "object", properties: { id: { type: "string" }, jours: { type: "number" }, max: { type: "number" } }, required: ["id"] },
      level: "read",
      handler: wrap(async (a) => {
        const id = String(a.id ?? "").trim();
        if (!id) return "id : il faut l'id d'une conversation (donné par m365_conversations_teams).";
        const days = clamp(a.jours, 30, 1, 90);
        const [me, chat, list] = await Promise.all([meId(), g.get<any>(`chats/${enc(id)}?$expand=members`), chatMessages(id, Date.now() - days * 864e5)]);
        labels.set(id, chatNameT(chat, me));
        const msgs = list.slice(0, clamp(a.max, 20, 1, 50)).reverse();
        if (!msgs.length) return `${chatName(chat, me)} : aucun message sur les ${days} derniers jours.`;
        return `${chatName(chat, me)} (du plus ancien au plus récent) :\n${msgs.map((m) => msgLine(m, me)).join("\n")}\n${DATA}`;
      }),
    },
    {
      name: "m365_canaux_teams",
      description: "Équipes Teams de l'utilisateur et leurs canaux (noms et ids, pour m365_messages_canal et m365_publier_canal). equipe : nom d'une équipe pour ne voir que ses canaux (facultatif).",
      inputSchema: { type: "object", properties: { equipe: { type: "string" } } },
      level: "read",
      handler: wrap(async (a) => {
        let ts = await joinedTeams();
        if (!ts.length) return "Tu n'es membre d'aucune équipe Teams.";
        if (a.equipe) { const one = pick(ts, String(a.equipe)); if (!one) return `Équipe « ${a.equipe} » introuvable. Tes équipes : ${ts.map((x) => x.displayName).join(", ")}.`; ts = [one]; }
        const shown = ts.slice(0, 15);
        const cs = await Promise.all(shown.map((x) => channelsOf(x.id).catch(() => [] as any[])));
        const out = shown.map((x, i) => `${x.displayName} [équipe id ${x.id}]\n${cs[i]!.map((c) => {
          labels.set(`${x.id}|${c.id}`, channelLabel(c.displayName, x.displayName));
          return `  - ${c.displayName}${c.membershipType && c.membershipType !== "standard" ? ` (${c.membershipType === "private" ? "privé" : "partagé"})` : ""} [canal id ${c.id}]`;
        }).join("\n")}`);
        return `${out.join("\n")}${ts.length > shown.length ? `\n(et ${ts.length - shown.length} autre(s) équipe(s) : précise le nom)` : ""}`;
      }),
    },
    {
      name: "m365_messages_canal",
      description: "Derniers messages d'un canal d'équipe Teams, avec leurs réponses ; signale ceux qui mentionnent l'utilisateur. equipe : nom (ou id) de l'équipe. canal : nom (ou id) du canal (défaut : Général). jours : période (défaut 7, 90 au plus). max : nombre de fils (défaut 10, 30 au plus). Rend les ids pour répondre avec m365_publier_canal.",
      inputSchema: { type: "object", properties: { equipe: { type: "string" }, canal: { type: "string" }, jours: { type: "number" }, max: { type: "number" } }, required: ["equipe"] },
      level: "read",
      handler: wrap(async (a) => {
        await need(CHANNEL_READ, CHANNEL_HINT);
        const days = clamp(a.jours, 7, 1, 90);
        const since = Date.now() - days * 864e5;
        const [me, { team, ch }] = await Promise.all([meId(), findChannel(String(a.equipe ?? ""), String(a.canal ?? ""))]);
        let r: { value: any[] };
        try {
          r = await g.get(`teams/${enc(team.id)}/channels/${enc(ch.id)}/messages?$top=50&$expand=replies`);
        } catch (e) {
          if (e instanceof Forbidden) throw new Error(CHANNEL_HINT);
          throw e;
        }
        const ok = (m: any) => m.messageType === "message" && !m.deletedDateTime;
        const activity = (p: any) => Math.max(Date.parse(p.createdDateTime) || 0, ...(p.replies ?? []).filter(ok).map((x: any) => Date.parse(x.createdDateTime) || 0));
        const posts = r.value.filter(ok).filter((p) => activity(p) >= since).sort((x, y) => activity(y) - activity(x)).slice(0, clamp(a.max, 10, 1, 30)).reverse();
        const head = `Canal « ${ch.displayName} » de l'équipe « ${team.displayName} » [équipe id ${team.id}, canal id ${ch.id}]`;
        if (!posts.length) return `${head} : aucun message sur les ${days} derniers jours.`;
        return `${head}, ${days} derniers jours, du plus ancien au plus récent :\n${posts.map((p) => {
          const replies = (p.replies ?? []).filter(ok).sort((x: any, y: any) => Date.parse(x.createdDateTime) - Date.parse(y.createdDateTime));
          const last = replies.slice(-3).map((x: any) => `    ↳ ${when(x.createdDateTime)} — ${author(x, me)} : « ${msgText(x, 300)} »${mentionsMe(x, me) ? " (te mentionne)" : ""}`);
          return `- ${when(p.createdDateTime)} — ${author(p, me)} : ${p.subject ? `[${p.subject}] ` : ""}« ${msgText(p)} »${mentionsMe(p, me) ? " (te mentionne)" : ""} [message id ${p.id}]${replies.length ? `\n${replies.length > 3 ? `    (${replies.length} réponses, les 3 dernières :)\n` : ""}${last.join("\n")}` : ""}`;
        }).join("\n")}\n${DATA}`;
      }),
    },
    {
      name: "m365_presence",
      description: "Disponibilité d'un collègue sur Teams (disponible, occupé, en réunion, absent…), son message de statut et son message d'absence. Utile avant de l'appeler ou de lui écrire. personne : nom ou adresse mail.",
      inputSchema: { type: "object", properties: { personne: { type: "string" } }, required: ["personne"] },
      level: "read",
      handler: wrap(async (a) => {
        const q = String(a.personne ?? "").trim();
        if (!q) return "personne : il faut un nom.";
        await need("Presence.Read.All");
        const u = await person(q);
        const p = await g.get<any>(`users/${enc(u.id)}/presence`);
        const act = ACTIVITY[p.activity] && ACTIVITY[p.activity] !== PRESENCE[p.availability] ? ` (${ACTIVITY[p.activity]})` : "";
        const status = p.statusMessage?.message?.content ? ` — statut : « ${plain(String(p.statusMessage.message.content), 200)} »` : "";
        const ooo = p.outOfOfficeSettings?.isOutOfOfficeEnabled ? ` — absent du bureau${p.outOfOfficeSettings.message ? ` : « ${plain(String(p.outOfOfficeSettings.message), 200)} »` : ""}` : "";
        return `${u.name} (${u.email}) : ${PRESENCE[p.availability] ?? p.availability ?? "inconnue"}${act}${status}${ooo}.${status || ooo ? `\n${DATA}` : ""}`;
      }),
    },
    {
      name: "m365_envoyer_message_teams",
      description: "Envoie un message Teams au nom de l'utilisateur : à une personne (discussion privée, créée si besoin) ou dans une conversation de groupe. destinataire : l'ADRESSE MAIL de la personne (rendue par m365_chercher_personnes ou m365_messages_teams) OU l'ID d'une conversation (rendu par m365_conversations_teams, m365_teams_non_lus, m365_messages_teams). Si tu n'as qu'un prénom, cherche d'abord l'adresse ; si plusieurs personnes correspondent, demande laquelle à l'utilisateur. Ne devine jamais. nom : nom de la personne ou du groupe (pour la carte d'accord). texte : le message, écrit comme l'utilisateur l'écrirait lui-même (première personne, court, naturel, ton adapté à la relation, sans signature). L'utilisateur voit le destinataire et le texte exact, et accepte avant l'envoi.",
      inputSchema: {
        type: "object",
        properties: { destinataire: { type: "string" }, nom: { type: "string" }, texte: { type: "string" } },
        required: ["destinataire", "texte"],
      },
      level: "write",
      summary: (a) => {
        const to = destLabel(String(a.destinataire ?? "").trim(), a.nom);
        return T(`Envoyer sur Teams à ${tr(to, "fr")} : « ${quote(a.texte)} »`, `Send on Teams to ${tr(to, "en")}: “${quote(a.texte)}”`);
      },
      handler: wrap(async (a) => {
        const dest = String(a.destinataire ?? "").trim();
        const text = String(a.texte ?? "").trim();
        if (!text) throw new Error("texte : le message est vide.");
        if (!dest) throw new Error("destinataire : il faut l'adresse mail de la personne ou l'id d'une conversation.");
        await need("ChatMessage.Send");
        let chatId = dest;
        if (EMAIL.test(dest)) {
          const me = await meId();
          const existing = (await chats()).find((c) => c.chatType === "oneOnOne" && others(c, me).some((m) => norm(m.email) === norm(dest)));
          if (existing) chatId = existing.id;
          else {
            await need("Chat.Create");
            const member = (bind: string) => ({ "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `${GRAPH}/users('${bind}')` });
            const c = await g.call<{ id: string }>("POST", "chats", { chatType: "oneOnOne", members: [member(me), member(dest)] });
            chatId = c.id;
          }
        } else if (!dest.startsWith("19:")) {
          throw new Error(`destinataire « ${dest} » : il faut une adresse mail ou un id de conversation (qui commence par « 19: »). Cherche d'abord l'adresse avec m365_chercher_personnes.`);
        }
        await g.call("POST", `chats/${enc(chatId)}/messages`, { body: { contentType: "html", content: toHtml(text) } });
        return `Message envoyé sur Teams à ${tr(destLabel(dest, a.nom), "fr")}. [conversation id ${chatId}]`;
      }),
    },
    {
      name: "m365_publier_canal",
      description: "Publie un message dans un canal d'équipe Teams au nom de l'utilisateur, ou répond dans le fil d'un message du canal. equipe_id et canal_id : rendus par m365_canaux_teams ou m365_messages_canal. reponse_a : id du message du canal auquel répondre (facultatif ; sans lui, c'est un nouveau fil visible par toute l'équipe). texte : le message, écrit comme l'utilisateur l'écrirait. L'utilisateur voit le canal et le texte exact, et accepte avant l'envoi.",
      inputSchema: {
        type: "object",
        properties: { equipe_id: { type: "string" }, canal_id: { type: "string" }, reponse_a: { type: "string" }, texte: { type: "string" } },
        required: ["equipe_id", "canal_id", "texte"],
      },
      level: "write",
      summary: (a) => {
        const where = labels.get(`${a.equipe_id}|${a.canal_id}`) ?? T("canal Teams (nom inconnu)", "Teams channel (unknown name)");
        return T(
          `${a.reponse_a ? "Répondre dans un fil du" : "Publier un nouveau message dans le"} ${tr(where, "fr")} : « ${quote(a.texte)} »`,
          `${a.reponse_a ? "Reply in a thread of the" : "Post a new message in the"} ${tr(where, "en")}: “${quote(a.texte)}”`,
        );
      },
      handler: wrap(async (a) => {
        const text = String(a.texte ?? "").trim();
        if (!text) throw new Error("texte : le message est vide.");
        await need("ChannelMessage.Send");
        const base = `teams/${enc(String(a.equipe_id ?? ""))}/channels/${enc(String(a.canal_id ?? ""))}/messages`;
        const path = a.reponse_a ? `${base}/${enc(String(a.reponse_a))}/replies` : base;
        await g.call("POST", path, { body: { contentType: "html", content: toHtml(text) } });
        return `${a.reponse_a ? "Réponse publiée" : "Message publié"} dans le ${tr(labels.get(`${a.equipe_id}|${a.canal_id}`) ?? "canal Teams", "fr")}.`;
      }),
    },
  ];
}
