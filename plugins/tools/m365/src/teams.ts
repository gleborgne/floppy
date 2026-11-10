// Outils Teams du plugin m365 : conversations (privées et de groupe), canaux d'équipe, présence, envoi.
//
// Parcours visés (utilisateur à son ordinateur) :
//  - « J'ai des messages Teams non lus ? »                 → m365_teams_unread
//  - « Qu'est-ce que Florent m'a envoyé ? » / « on parlait de quoi avec Florent ? » → m365_teams_messages
//  - « Lis-moi la conversation du groupe Projet Voix »     → m365_teams_chats puis m365_read_teams_chat
//  - « Quoi de neuf dans le canal Général de Marketing ? » → m365_channel_messages (m365_teams_channels pour la liste)
//  - « Florent est dispo ? »                               → m365_presence
//  - « Envoie un message à Florent pour lui demander… »    → m365_send_teams_message (carte d'accord)
//  - « Réponds dans le canal / dans ce fil »              → m365_post_channel (carte d'accord)
//
// Envoi : le destinataire est TOUJOURS une adresse ou un id précis, jamais un prénom deviné. La carte d'accord
// montre le nom complet, l'adresse et le texte exact. Les canaux se lisent seulement si un administrateur
// Microsoft a approuvé la permission ChannelMessage.Read.All (bouton « Autoriser les canaux »).
import { T, tr, type Text, type ToolDef } from "@floppy/core";
import { CHANNEL_READ, GRAPH, RELOGIN, type GraphAuth } from "./graph.ts";
import { channelReadTool } from "./channel-search.ts";
import { loadChatPages, teamsReadTools } from "./teams-read.ts";
import { Scan, invalid } from "./query.ts";
import { DATA, norm, plain, toHtml, wrap } from "./util.ts";

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

export function teamsTools(g: GraphAuth, max: number, labels: Map<string, Text>): ToolDef[] {
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
  const channelLabel = (ch: string, team: string): Text => T(`canal « ${ch} » de l'équipe « ${team} »`, `channel “${ch}” of team “${team}”`);
  /** Retient les noms pour les cartes d'accord ; pas d'envoi sur un inventaire incomplet. */
  const chats = async (): Promise<any[]> => {
    const scan = new Scan();
    const r = { value: await loadChatPages(g, scan) };
    if (scan.partial) invalid("Liste des conversations incomplète : impossible de choisir le destinataire.", "Incomplete chat list: cannot choose the recipient.");
    const me = await meId();
    for (const c of r.value) {
      labels.set(c.id, chatNameT(c, me));
      for (const m of c.members ?? []) if (m.email && m.userId !== me) labels.set(norm(m.email), m.displayName);
    }
    return r.value.sort((a, b) => lastAt(b) - lastAt(a));
  };
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
    const exact = list.filter((x) => x.id === q || norm(x.displayName) === norm(q));
    const candidates = exact.length ? exact : list.filter((x) => w.every((y) => norm(x.displayName).includes(y)));
    if (candidates.length > 1) invalid(`Plusieurs correspondances : ${candidates.map((x) => x.displayName).join(", ")}. Précise le nom.`, `Several matches: ${candidates.map((x) => x.displayName).join(", ")}. Specify the name.`);
    return candidates[0];
  };
  const findChannel = async (equipe: string, canal: string) => {
    const ts = await joinedTeams();
    const team = pick(ts, equipe);
    if (!team) throw new Error(`Équipe « ${equipe} » introuvable. Tes équipes : ${ts.map((x) => x.displayName).join(", ") || "aucune"}.`);
    const cs = await channelsOf(team.id);
    const ch = canal ? pick(cs, canal) : cs.find((x) => norm(x.displayName) === "general");
    if (!ch) throw new Error(`Canal « ${canal} » introuvable dans « ${team.displayName} ». Canaux : ${cs.map((x) => x.displayName).join(", ")}.`);
    labels.set(`${team.id}|${ch.id}`, channelLabel(ch.displayName, team.displayName));
    return { team, ch };
  };

  // --- Personnes
  /** Un nom ambigu doit être précisé, même pour lire la présence. */
  const person = async (q: string) => {
    let email = EMAIL.test(q) ? q : undefined;
    if (!email) {
      const r = await g.get<{ value: any[]; "@odata.nextLink"?: string }>(`me/people?$search="${enc(q.replace(/"/g, " "))}"&$top=10&$select=displayName,scoredEmailAddresses`);
      const exact = r.value.filter((p) => norm(p.displayName) === norm(q));
      const candidates = exact.length ? exact : r.value;
      if (candidates.length > 1 || r["@odata.nextLink"]) invalid(`Plusieurs personnes correspondent : ${candidates.map((p) => p.displayName).join(", ")}. Précise le nom ou l'adresse.`, `Several people match: ${candidates.map((p) => p.displayName).join(", ")}. Specify the name or email.`);
      email = candidates[0]?.scoredEmailAddresses?.[0]?.address;
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
    ...teamsReadTools(g, max, labels),
    {
      name: "m365_teams_channels",
      description: "Équipes Teams de l'utilisateur et leurs canaux (noms et ids, pour m365_channel_messages et m365_post_channel). team : nom d'une équipe pour ne voir que ses canaux (facultatif).",
      inputSchema: { type: "object", properties: { team: { type: "string" } } },
      level: "read",
      handler: wrap(async (a) => {
        let ts = await joinedTeams();
        if (!ts.length) return "Tu n'es membre d'aucune équipe Teams.";
        if (a.team) { const one = pick(ts, String(a.team)); if (!one) return `Équipe « ${a.team} » introuvable. Tes équipes : ${ts.map((x) => x.displayName).join(", ")}.`; ts = [one]; }
        const shown = ts.slice(0, 15);
        const cs = await Promise.all(shown.map((x) => channelsOf(x.id).catch(() => [] as any[])));
        const out = shown.map((x, i) => `${x.displayName} [équipe id ${x.id}]\n${cs[i]!.map((c) => {
          labels.set(`${x.id}|${c.id}`, channelLabel(c.displayName, x.displayName));
          return `  - ${c.displayName}${c.membershipType && c.membershipType !== "standard" ? ` (${c.membershipType === "private" ? "privé" : "partagé"})` : ""} [canal id ${c.id}]`;
        }).join("\n")}`);
        return `${out.join("\n")}${ts.length > shown.length ? `\n(et ${ts.length - shown.length} autre(s) équipe(s) : précise le nom)` : ""}`;
      }),
    },
    channelReadTool(g, { authorize: () => need(CHANNEL_READ, CHANNEL_HINT), me: meId, resolve: findChannel }),
    {
      name: "m365_presence",
      description: "Disponibilité d'un collègue sur Teams (disponible, occupé, en réunion, absent…), son message de statut et son message d'absence. Utile avant de l'appeler ou de lui écrire. person : nom ou adresse mail.",
      inputSchema: { type: "object", properties: { person: { type: "string" } }, required: ["person"] },
      level: "read",
      handler: wrap(async (a) => {
        const q = String(a.person ?? "").trim();
        if (!q) return "person : il faut un nom.";
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
      name: "m365_send_teams_message",
      description: "Envoie un message Teams au nom de l'utilisateur : à une personne (discussion privée, créée si besoin) ou dans une conversation de groupe. recipient : l'ADRESSE MAIL de la personne (rendue par m365_search_people ou m365_teams_messages) OU l'ID d'une conversation (rendu par m365_teams_chats, m365_teams_unread, m365_teams_messages). Si tu n'as qu'un prénom, cherche d'abord l'adresse ; si plusieurs personnes correspondent, demande laquelle à l'utilisateur. Ne devine jamais. name : nom de la personne ou du groupe (pour la carte d'accord). text : le message, écrit comme l'utilisateur l'écrirait lui-même (première personne, court, naturel, ton adapté à la relation, sans signature). L'utilisateur voit le destinataire et le texte exact, et accepte avant l'envoi.",
      inputSchema: {
        type: "object",
        properties: { recipient: { type: "string" }, name: { type: "string" }, text: { type: "string" } },
        required: ["recipient", "text"],
      },
      level: "write",
      summary: (a) => {
        const to = destLabel(String(a.recipient ?? "").trim(), a.name);
        return T(`Envoyer sur Teams à ${tr(to, "fr")} : « ${quote(a.text)} »`, `Send on Teams to ${tr(to, "en")}: “${quote(a.text)}”`);
      },
      handler: wrap(async (a) => {
        const dest = String(a.recipient ?? "").trim();
        const text = String(a.text ?? "").trim();
        if (!text) throw new Error("text : le message est vide.");
        if (!dest) throw new Error("recipient : il faut l'adresse mail de la personne ou l'id d'une conversation.");
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
          throw new Error(`recipient « ${dest} » : il faut une adresse mail ou un id de conversation (qui commence par « 19: »). Cherche d'abord l'adresse avec m365_search_people.`);
        }
        await g.call("POST", `chats/${enc(chatId)}/messages`, { body: { contentType: "html", content: toHtml(text) } });
        return `Message envoyé sur Teams à ${tr(destLabel(dest, a.name), "fr")}. [conversation id ${chatId}]`;
      }),
    },
    {
      name: "m365_post_channel",
      description: "Publie un message dans un canal d'équipe Teams au nom de l'utilisateur, ou répond dans le fil d'un message du canal. team_id et channel_id : rendus par m365_teams_channels ou m365_channel_messages. reply_to : id du message du canal auquel répondre (facultatif ; sans lui, c'est un nouveau fil visible par toute l'équipe). text : le message, écrit comme l'utilisateur l'écrirait. L'utilisateur voit le canal et le texte exact, et accepte avant l'envoi.",
      inputSchema: {
        type: "object",
        properties: { team_id: { type: "string" }, channel_id: { type: "string" }, reply_to: { type: "string" }, text: { type: "string" } },
        required: ["team_id", "channel_id", "text"],
      },
      level: "write",
      summary: (a) => {
        const where = labels.get(`${a.team_id}|${a.channel_id}`) ?? T("canal Teams (nom inconnu)", "Teams channel (unknown name)");
        return T(
          `${a.reply_to ? "Répondre dans un fil du" : "Publier un nouveau message dans le"} ${tr(where, "fr")} : « ${quote(a.text)} »`,
          `${a.reply_to ? "Reply in a thread of the" : "Post a new message in the"} ${tr(where, "en")}: “${quote(a.text)}”`,
        );
      },
      handler: wrap(async (a) => {
        const text = String(a.text ?? "").trim();
        if (!text) throw new Error("text : le message est vide.");
        await need("ChannelMessage.Send");
        const base = `teams/${enc(String(a.team_id ?? ""))}/channels/${enc(String(a.channel_id ?? ""))}/messages`;
        const path = a.reply_to ? `${base}/${enc(String(a.reply_to))}/replies` : base;
        await g.call("POST", path, { body: { contentType: "html", content: toHtml(text) } });
        return `${a.reply_to ? "Réponse publiée" : "Message publié"} dans le ${tr(labels.get(`${a.team_id}|${a.channel_id}`) ?? "canal Teams", "fr")}.`;
      }),
    },
  ];
}
