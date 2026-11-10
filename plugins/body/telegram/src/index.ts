// Plugin `body-telegram` : parler à Floppy sur Telegram, dans une discussion privée avec un bot.
// C'est un corps (il reçoit et répond), pas un canal d'envoi : voir docs/spec/telegram.md.
// - Le bot lit ses messages par « long polling » (getUpdates) : rien à ouvrir sur la box, rien n'arrive de l'extérieur.
// - Liste blanche : seuls les numéros d'utilisateur réglés dans la fenêtre des réglages (jamais à la voix) parlent à
//   Floppy. Discussions privées seulement. Tout autre message est ignoré et noté au journal.
// - Chaque personne autorisée est un corps texte du hub (`telegram-<numéro>`) : capacités text, approval, choice,
//   document. Une demande d'accord née de sa discussion arrive avec des boutons Oui / Non.
// - Le jeton va dans le coffre des secrets, jamais dans un fichier, ni dans un log, ni dans un message d'erreur.
import { join } from "node:path";
import { z } from "zod";
import { definePlugin, errorText, itemSecret, readJsonFile, T, tr, writeJsonAtomic, type ItemInfo, type ItemKind, type OpResult, type Text } from "@floppy/core";
import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import { callTelegram, esc, telegramMessages, TelegramError, type FetchLike } from "@floppy/toolkit/telegram";

const Config = z.object({
  /** Attente d'un appel getUpdates (long polling), en secondes. */
  pollTimeout_s: z.number().int().min(0).max(50).default(25),
  /** Délai d'un envoi (sendMessage…), en secondes. */
  timeout_s: z.number().int().min(1).max(120).default(15),
  /** Un message plus vieux (Floppy éteint) n'est pas traité : Floppy demande de le renvoyer. En minutes. */
  maxAge_min: z.number().int().min(1).max(1440).default(30),
});
type Config = z.infer<typeof Config>;

type Announce = "important" | "all" | "none";
interface Values { label: string; users: string[]; announce: Announce }
type Entry = Values & { id: string };

const CAPABILITIES: Capability[] = ["text", "approval", "choice", "document"];

const KIND: ItemKind = {
  id: "bot",
  label: T("Bot Telegram", "Telegram bot"),
  description: T(
    "1. Dans Telegram, écris à @BotFather : /newbot. Il te donne un jeton : colle-le ci-dessous. Prends un autre bot que celui du canal de veille.\n"
    + "2. Écris un message à ton bot, puis « Qui m'a écrit ? » sur cette ligne : ton numéro s'affiche. Mets-le dans « Personnes autorisées ».\n"
    + "Sécurité : seules les personnes de la liste parlent à Floppy ; les autres sont ignorées. Chez @BotFather, /setjoingroups → Disable. Jeton volé ? /revoke chez @BotFather, puis colle le nouveau ici.",
    "1. In Telegram, message @BotFather: /newbot. It gives you a token: paste it below. Use another bot than the news channel's.\n"
    + "2. Send a message to your bot, then “Who wrote to me?” on this line: your number shows. Put it in “Allowed people”.\n"
    + "Security: only the people in the list talk to Floppy; others are ignored. At @BotFather, /setjoingroups → Disable. Token stolen? /revoke at @BotFather, then paste the new one here.",
  ),
  cloud: true,
  fields: [
    { key: "label", label: T("Nom", "Name"), type: "text", required: true, placeholder: T("Mon téléphone", "My phone") },
    { key: "token", label: T("Jeton du bot", "Bot token"), type: "secret", required: true,
      hint: T("Rangé dans le coffre de mots de passe du système, jamais dans un fichier.", "Stored in the system password vault, never in a file.") },
    { key: "users", label: T("Personnes autorisées", "Allowed people"), type: "list", placeholder: "123456789",
      hint: T("Un numéro d'utilisateur Telegram par ligne (« Qui m'a écrit ? » le donne). Vide : personne.", "One Telegram user number per line (“Who wrote to me?” gives it). Empty: nobody.") },
    { key: "announce", label: T("Annonces sur Telegram", "Announcements on Telegram"), type: "select", default: "important",
      options: [
        { value: "important", label: T("Seulement les importantes (rappels…)", "Only important ones (reminders…)") },
        { value: "all", label: T("Toutes", "All") },
        { value: "none", label: T("Aucune", "None") },
      ] },
  ],
};

function clean(v: Record<string, unknown>): Values {
  const raw = Array.isArray(v.users) ? v.users : typeof v.users === "string" ? v.users.split(/[\s,;]+/) : [];
  const users = [...new Set(raw.map((x) => String(x).trim()).filter((x) => /^\d{1,15}$/.test(x)))];
  const a = String(v.announce ?? "important");
  return { label: String(v.label ?? "").trim(), users, announce: a === "all" || a === "none" ? a : "important" };
}

/** Une personne autorisée, branchée au hub comme un corps texte. */
interface UserBody {
  id: string;
  chat: number;
  msgFn?: (m: BodyToKernel) => void;
  closeFns: (() => void)[];
  /** Messages envoyés pour une demande d'accord ou un choix : pour retirer les boutons à la fin. */
  asks: Map<string, { message: number; text: string; options?: { id: string; label: string }[] }>;
  /** Envois de ce corps, l'un après l'autre (l'ordre des messages est gardé). */
  chain: Promise<void>;
  lastTyping: number;
}

interface Bot {
  entry: Entry;
  token: string;
  stop: AbortController;
  bodies: Map<string, UserBody>;
  state: { tone: "ok" | "warn" | "error"; text: Text };
}

export function createTelegramBodyPlugin(fetchImpl?: FetchLike) {
  return definePlugin<Config>({
    manifest: {
      id: "body-telegram",
      version: "0.1.0",
      licence: "MIT",
      description: "Parler à Floppy sur Telegram : discussion privée avec un bot, liste blanche, accords par boutons.",
      sections: [{ id: "body", label: T("Corps et affichage", "Bodies and display") }],
      inject: ["body"],
      permissions: { net: ["api.telegram.org"], cloud: true },
      addable: {
        section: "body", label: T("Telegram", "Telegram"), cloud: true, single: true,
        description: T("Écris à Floppy depuis ton téléphone, et réponds à ses demandes d'accord.", "Write to Floppy from your phone, and answer its approval requests."),
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const hub = ctx.get("body");
      const store = ctx.items.store();
      const secret = itemSecret(ctx, (id) => `body-telegram/${id}/token`);
      const lang = () => (ctx.assistant.language === "en" ? "en" : "fr");
      const say = (t: Text) => tr(t, lang());
      const all = (): Entry[] => Object.entries(store.merge({})).map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>), id }));
      const sendSignal = () => AbortSignal.timeout(cfg.timeout_s * 1000);
      const doFetch: FetchLike = fetchImpl ?? ((url, init) => ctx.fetch(url, { ...init, timeoutMs: (cfg.pollTimeout_s + cfg.timeout_s) * 1000 }));

      // Où reprendre la lecture des messages (un message lu n'est jamais traité deux fois, même après un redémarrage).
      const offsetsFile = join(ctx.home, "body-telegram", "offsets.json");
      const offsets: Record<string, number> = readJsonFile<Record<string, number>>(offsetsFile) ?? {};
      /** Personnes non autorisées qui ont écrit (pour « Qui m'a écrit ? »). */
      const strangers = new Map<string, Map<string, { name: string; at: number }>>();
      const bots = new Map<string, Bot>();

      // ------------------------------------------------------------ envoyer
      const api = (bot: Bot, method: string, body: Record<string, unknown>) => callTelegram(doFetch, bot.token, method, body, AbortSignal.any([bot.stop.signal, sendSignal()]));
      /** Envoie du HTML de Telegram ; rend le numéro du message. */
      const sendHtml = async (bot: Bot, chat: number, html: string, extra: Record<string, unknown> = {}): Promise<number | undefined> => {
        const r = await api(bot, "sendMessage", { chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
        return (r.result as { message_id?: number } | undefined)?.message_id;
      };
      const queue = (bot: Bot, b: UserBody, job: () => Promise<void>) => {
        b.chain = b.chain.then(job).catch((e) => ctx.log("warn", `envoi Telegram à ${b.id} : ${tr(errorText(e), "fr")}`));
      };
      const sendMarkdown = (bot: Bot, b: UserBody, title: string, markdown: string) =>
        queue(bot, b, async () => { for (const html of telegramMessages(title, markdown)) await sendHtml(bot, b.chat, html); });

      // ------------------------------------------------------------ noyau → Telegram
      const fromKernel = (bot: Bot, b: UserBody, m: KernelToBody) => {
        const en = lang() === "en";
        switch (m.type) {
          case "reply.done":
            if (m.text.trim()) sendMarkdown(bot, b, "", m.text);
            break;
          case "state":
            // « en train d'écrire… » pendant que Floppy réfléchit (Telegram l'efface seul après 5 s).
            if (m.state === "thinking" && Date.now() - b.lastTyping > 4000) {
              b.lastTyping = Date.now();
              void api(bot, "sendChatAction", { chat_id: b.chat, action: "typing" }).catch(() => {});
            }
            break;
          case "document": sendMarkdown(bot, b, m.title, m.markdown); break;
          case "card": sendMarkdown(bot, b, m.title, m.lines.join("\n")); break;
          case "notify":
            if (bot.entry.announce === "all" || (bot.entry.announce === "important" && m.important)) sendMarkdown(bot, b, "", m.text);
            break;
          case "error": queue(bot, b, async () => { await sendHtml(bot, b.chat, `⚠️ ${esc(m.text)}`); }); break;
          case "approval.request": {
            // Seulement les demandes nées de cette discussion : celles de l'ordinateur restent sur l'ordinateur.
            if (m.origin !== b.id) break;
            const text = `🔐 ${esc(m.summary)}`;
            queue(bot, b, async () => {
              const message = await sendHtml(bot, b.chat, text, { reply_markup: { inline_keyboard: [[
                { text: en ? "Yes" : "Oui", callback_data: `a:${m.id}:1` }, { text: en ? "No" : "Non", callback_data: `a:${m.id}:0` },
              ]] } });
              if (message !== undefined) b.asks.set(m.id, { message, text });
            });
            break;
          }
          case "approval.closed": {
            // Dans la file : le message de la demande est peut-être encore en route.
            const done = m.ok ? (en ? "✅ Accepted" : "✅ Accepté") : (en ? "❌ Refused" : "❌ Refusé");
            queue(bot, b, async () => {
              const ask = b.asks.get(m.id);
              if (!ask) return;
              b.asks.delete(m.id);
              await api(bot, "editMessageText", { chat_id: b.chat, message_id: ask.message, text: `${ask.text}\n${done}`, parse_mode: "HTML" });
            });
            break;
          }
          case "choice.request": {
            if (m.origin !== b.id) break;
            const text = esc(m.title);
            const options = m.options.map((o) => ({ id: o.id, label: o.label }));
            queue(bot, b, async () => {
              const message = await sendHtml(bot, b.chat, text, { reply_markup: { inline_keyboard: m.options.map((o, i) => [{ text: o.label.slice(0, 60), callback_data: `c:${m.id}:${i}` }]) } });
              if (message !== undefined) b.asks.set(m.id, { message, text, options });
            });
            break;
          }
          case "choice.closed": {
            queue(bot, b, async () => {
              const ask = b.asks.get(m.id);
              if (!ask) return;
              b.asks.delete(m.id);
              const picked = ask.options?.find((o) => o.id === m.picked)?.label;
              const done = picked ? `→ ${esc(picked)}` : en ? "(closed)" : "(fermé)";
              await api(bot, "editMessageText", { chat_id: b.chat, message_id: ask.message, text: `${ask.text}\n${done}`, parse_mode: "HTML" });
            });
            break;
          }
          default: break; // émotions, humeur, voix, transcription : rien à montrer sur Telegram
        }
      };

      /** Le corps d'une personne autorisée : branché au hub à la première occasion, gardé ensuite. */
      const bodyOf = (bot: Bot, user: string, name?: string): UserBody => {
        const id = `telegram-${user}`;
        const cur = bot.bodies.get(id);
        if (cur) return cur;
        const b: UserBody = { id, chat: Number(user), closeFns: [], asks: new Map(), chain: Promise.resolve(), lastTyping: 0 };
        bot.bodies.set(id, b);
        const transport: BodyTransport = {
          send: (m) => fromKernel(bot, b, m),
          sendAudio: () => { /* pas de voix sur Telegram pour l'instant */ },
          onMessage: (fn) => { b.msgFn = fn; },
          onAudio: () => {},
          onClose: (fn) => { b.closeFns.push(fn); },
          close: () => detach(bot, b),
        };
        const label = `Telegram · ${name ?? bot.entry.label}`;
        hub.attach(transport, { id, name: label, managed: true });
        b.msgFn?.({ type: "hello", id, name: label, version: "0.1.0", managed: true, capabilities: CAPABILITIES });
        ctx.items.changed();
        return b;
      };
      const detach = (bot: Bot, b: UserBody) => {
        if (!bot.bodies.delete(b.id)) return;
        const fns = b.closeFns;
        b.closeFns = [];
        b.msgFn = undefined;
        for (const fn of fns) { try { fn(); } catch { /* rien */ } }
      };

      // ------------------------------------------------------------ Telegram → noyau
      const stranger = (bot: Bot, user: string, name: string) => {
        const list = strangers.get(bot.entry.id) ?? new Map<string, { name: string; at: number }>();
        list.delete(user);
        list.set(user, { name, at: Date.now() });
        while (list.size > 10) list.delete(list.keys().next().value!);
        strangers.set(bot.entry.id, list);
        ctx.audit.write({ kind: "body-telegram.refused", bot: bot.entry.id, user });
      };
      const handle = async (bot: Bot, u: Record<string, any>, stale: Set<string>) => {
        const q = u.callback_query;
        if (q) {
          const user = String(q.from?.id ?? "");
          void api(bot, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
          if (!bot.entry.users.includes(user)) { stranger(bot, user, String(q.from?.first_name ?? "?")); return; }
          const b = bodyOf(bot, user, q.from?.first_name);
          const [kind, id, value] = String(q.data ?? "").split(":");
          if (kind === "a" && id) b.msgFn?.({ type: "approval.response", id, ok: value === "1" });
          else if (kind === "c" && id) {
            const option = b.asks.get(id)?.options?.[Number(value)]?.id;
            if (option !== undefined) b.msgFn?.({ type: "choice.response", id, option });
          }
          return;
        }
        const m = u.message;
        if (!m) return;
        const user = String(m.from?.id ?? "");
        if (m.chat?.type !== "private") { ctx.audit.write({ kind: "body-telegram.not_private", bot: bot.entry.id, chat: String(m.chat?.id ?? "") }); return; }
        if (!bot.entry.users.includes(user)) { stranger(bot, user, String(m.from?.first_name ?? "?")); return; }
        const b = bodyOf(bot, user, m.from?.first_name);
        const reply = (t: Text) => queue(bot, b, async () => { await sendHtml(bot, b.chat, esc(say(t))); });
        if (Date.now() / 1000 - Number(m.date ?? 0) > cfg.maxAge_min * 60) {
          if (!stale.has(user)) { stale.add(user); reply(T("J'étais éteint quand tu m'as écrit. Renvoie ta demande si elle tient toujours.", "I was off when you wrote. Send your request again if it still stands.")); }
          return;
        }
        const text = typeof m.text === "string" ? m.text.trim() : "";
        if (text === "/start") { reply(T(`Bonjour, je suis ${ctx.assistant.name}. Écris-moi ce que tu veux, comme à la voix.`, `Hello, I'm ${ctx.assistant.name}. Write me what you want, as you would say it.`)); return; }
        if (text) { b.msgFn?.({ type: "text", text }); return; }
        if (m.voice || m.audio || m.video_note) reply(T("Je ne lis pas encore les messages vocaux : écris-moi.", "I can't read voice messages yet: write to me."));
        else reply(T("Je lis seulement le texte pour l'instant.", "I only read text for now."));
      };

      const setState = (bot: Bot, tone: Bot["state"]["tone"], text: Text) => {
        const changed = bot.state.tone !== tone || tr(bot.state.text, "fr") !== tr(text, "fr");
        bot.state = { tone, text };
        if (changed) ctx.items.changed();
      };
      const wait = (ms: number) => new Promise<void>((ok) => ctx.timeout(ok, ms));

      /** Lit les messages du bot jusqu'à son arrêt. Ne lève jamais ; réessaie seul (2 s, puis jusqu'à 60 s). */
      const poll = async (bot: Bot) => {
        let backoff = 2000;
        while (!bot.stop.signal.aborted && ctx.alive) {
          try {
            const r = await callTelegram(doFetch, bot.token, "getUpdates",
              { offset: offsets[bot.entry.id] ?? 0, timeout: cfg.pollTimeout_s, allowed_updates: ["message", "callback_query"] },
              AbortSignal.any([bot.stop.signal, AbortSignal.timeout((cfg.pollTimeout_s + cfg.timeout_s) * 1000)]));
            backoff = 2000;
            setState(bot, "ok", T(`en écoute · ${bot.entry.users.length} personne${bot.entry.users.length > 1 ? "s" : ""} autorisée${bot.entry.users.length > 1 ? "s" : ""}`, `listening · ${bot.entry.users.length} allowed ${bot.entry.users.length > 1 ? "people" : "person"}`));
            const updates = Array.isArray(r.result) ? (r.result as Record<string, any>[]) : [];
            const stale = new Set<string>();
            for (const u of updates) {
              if (bot.stop.signal.aborted) return;
              offsets[bot.entry.id] = Number(u.update_id) + 1;
              try { await handle(bot, u, stale); } catch (e) { ctx.log("warn", `message Telegram : ${String(e)}`); }
            }
            if (updates.length) writeJsonAtomic(offsetsFile, offsets);
            if (!updates.length && cfg.pollTimeout_s === 0) await wait(500);
          } catch (e) {
            if (bot.stop.signal.aborted || !ctx.alive) return;
            if (e instanceof TelegramError && e.status === 401) { setState(bot, "error", errorText(e)); return; }
            setState(bot, "warn", errorText(e));
            ctx.log("warn", `Telegram ${bot.entry.label} : ${tr(errorText(e), "fr")}`);
            await wait(backoff);
            backoff = Math.min(backoff * 2, 60_000);
          }
        }
      };

      // ------------------------------------------------------------ démarrer et arrêter un bot
      const stopBot = (id: string) => {
        const bot = bots.get(id);
        if (!bot) return;
        bots.delete(id);
        bot.stop.abort();
        for (const b of [...bot.bodies.values()]) detach(bot, b);
      };
      const startBot = (e: Entry) => {
        stopBot(e.id);
        const token = secret.get(e.id);
        if (!store.isEnabled(e.id) || !token) return;
        const bot: Bot = { entry: e, token, stop: new AbortController(), bodies: new Map(), state: { tone: "warn", text: T("connexion…", "connecting…") } };
        bots.set(e.id, bot);
        // Les personnes autorisées sont branchées tout de suite : les annonces leur arrivent avant qu'elles écrivent.
        if (e.announce !== "none") for (const u of e.users) bodyOf(bot, u);
        void poll(bot);
      };
      const restart = () => { for (const e of all()) startBot(e); for (const id of [...bots.keys()]) if (!all().some((e) => e.id === id)) stopBot(id); };
      ctx.effect(() => { for (const id of [...bots.keys()]) stopBot(id); });
      // Démarrage en arrière-plan : apply reste court.
      ctx.timeout(restart, 0);

      // ------------------------------------------------------------ fenêtre des réglages
      const info = (e: Entry): ItemInfo => {
        const on = store.isEnabled(e.id);
        const bot = bots.get(e.id);
        const hasToken = secret.has(e.id);
        const status = !on ? "off" : !hasToken || !e.users.length ? "warn" : bot?.state.tone === "error" ? "error" : bot?.state.tone ?? "warn";
        return {
          id: e.id, label: e.label, kind: "bot", enabled: on, cloud: true,
          detail: T(`Telegram · ${e.users.length} personne(s) autorisée(s)`, `Telegram · ${e.users.length} allowed`),
          status,
          statusText: !on ? T("désactivé : Floppy ne lit plus ce bot", "disabled: Floppy no longer reads this bot")
            : !hasToken ? T("pas de jeton de bot", "no bot token")
            : !e.users.length ? T("personne n'est autorisé : écris au bot, puis « Qui m'a écrit ? »", "nobody is allowed: write to the bot, then “Who wrote to me?”")
            : bot?.state.text,
          values: { ...e, token: secret.shown(e.id) } as unknown as Record<string, unknown>,
          editable: true, removable: true, toggleable: true,
          actions: [{ id: "strangers", label: T("Qui m'a écrit ?", "Who wrote to me?") }],
        };
      };
      const check = (v: Values): Text | undefined => (v.label ? undefined : T("Il faut un nom.", "A name is required."));
      ctx.items.declare({
        id: "body-telegram", section: "body", order: 40,
        label: T("Telegram", "Telegram"),
        description: T("Parle à Floppy depuis Telegram. Les messages passent par les serveurs de Telegram.", "Talk to Floppy from Telegram. Messages go through Telegram's servers."),
        addLabel: T("Ajouter un bot Telegram", "Add a Telegram bot"),
        badge: T("cloud", "cloud"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values): Promise<OpResult> => {
          if (kind !== "bot") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
          const v = clean(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          const id = store.add("bot", v as unknown as Record<string, unknown>, v.label, []);
          secret.apply(id, values.token);
          restart();
          ctx.items.changed();
          return { ok: true, id, text: T(`${v.label} ajouté.`, `${v.label} added.`) };
        },
        update: async (id, values) => {
          const cur = all().find((e) => e.id === id);
          if (!cur) return { ok: false, text: T(`Bot inconnu : ${id}`, `Unknown bot: ${id}`) };
          const v = clean({ ...cur, ...values });
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          store.update(id, v as unknown as Record<string, unknown>);
          secret.apply(id, values.token);
          restart();
          ctx.items.changed();
          return { ok: true, id, text: T(`${v.label} modifié.`, `${v.label} updated.`) };
        },
        remove: async (id) => {
          const cur = all().find((e) => e.id === id);
          if (!cur) return { ok: false, text: T(`Bot inconnu : ${id}`, `Unknown bot: ${id}`) };
          stopBot(id);
          store.remove(id);
          secret.remove(id);
          delete offsets[id];
          writeJsonAtomic(offsetsFile, offsets);
          ctx.items.changed();
          return { ok: true, text: T(`${cur.label} supprimé.`, `${cur.label} removed.`) };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((e) => e.id === id);
          if (!cur) return { ok: false, text: T(`Bot inconnu : ${id}`, `Unknown bot: ${id}`) };
          store.setEnabled(id, on);
          restart();
          ctx.items.changed();
          return { ok: true, text: on ? T(`${cur.label} activé.`, `${cur.label} enabled.`) : T(`${cur.label} désactivé : Floppy ne le lit plus (rien n'est supprimé).`, `${cur.label} disabled: Floppy no longer reads it (nothing deleted).`) };
        },
        // « Essayer » : le jeton est-il bon ? (getMe ne lit aucun message : pas de conflit avec la lecture en cours.)
        test: async (_kind, values, id): Promise<OpResult> => {
          const token = secret.typedOr(id, values.token);
          if (!token) return { ok: false, text: T("Il faut le jeton du bot.", "The bot token is required.") };
          try {
            const r = await callTelegram(doFetch, token, "getMe", {}, sendSignal());
            const name = (r.result as { username?: string } | undefined)?.username;
            return { ok: true, text: T(`Jeton accepté : bot @${name ?? "?"}. Écris-lui un message, puis « Qui m'a écrit ? ».`, `Token accepted: bot @${name ?? "?"}. Send it a message, then “Who wrote to me?”.`) };
          } catch (e) {
            return { ok: false, text: errorText(e) };
          }
        },
        action: async (id, action): Promise<OpResult> => {
          if (action !== "strangers") return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
          const list = [...(strangers.get(id) ?? new Map()).entries()].reverse();
          if (!list.length) return { ok: true, text: T("Personne d'autre n'a écrit au bot depuis le démarrage. Écris-lui un message, puis réessaie.", "Nobody else wrote to the bot since startup. Send it a message, then try again.") };
          return { ok: true, text: T(
            `Ont écrit sans être autorisés (mets le numéro dans « Personnes autorisées ») :\n${list.map(([u, s]) => `${s.name} : ${u}`).join("\n")}`,
            `Wrote without being allowed (put the number in “Allowed people”):\n${list.map(([u, s]) => `${s.name}: ${u}`).join("\n")}`,
          ) };
        },
      });
    },
  });
}

export default createTelegramBodyPlugin();
