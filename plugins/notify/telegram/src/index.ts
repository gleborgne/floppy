// Plugin `notify-telegram` : envoie un texte (Markdown) dans un canal ou une discussion Telegram, par un bot.
// - Chaque destination (nom, jeton du bot, canal) est ajoutée par l'utilisateur dans les réglages (rubrique « Notifications »).
// - Le jeton va dans le coffre des secrets (ctx.secrets), jamais dans un fichier, ni dans un log, ni dans un message d'erreur.
// - Chaque destination active est offerte comme service `notify` : un plugin (ex. le planificateur) en emprunte une pour envoyer.
import { z } from "zod";
import { definePlugin, errorText, itemSecret, T, TextError, tr, type FieldDef, type ItemInfo, type ItemKind, type OpResult, type Text } from "@floppy/core";
import type { NotifyMessage } from "@floppy/contracts";
import { callTelegram, telegramMessages, type FetchLike } from "@floppy/toolkit/telegram";

export { toTelegramHtml, toTelegramBlocks, telegramMessages } from "@floppy/toolkit/telegram";

const Config = z.object({
  timeout_s: z.number().default(15),
});
type Config = z.infer<typeof Config>;

interface Values {
  label: string;
  chat: string;
}
type Entry = Values & { id: string };

const FIELDS: FieldDef[] = [
  { key: "label", label: T("Nom", "Name"), type: "text", required: true, placeholder: T("Mon canal", "My channel") },
  { key: "token", label: T("Jeton du bot", "Bot token"), type: "secret", required: true,
    hint: T("Créé avec @BotFather sur Telegram. Rangé dans le coffre de mots de passe du système, jamais dans un fichier.",
      "Created with @BotFather on Telegram. Stored in the system password vault, never in a file.") },
  { key: "chat", label: T("Canal ou discussion", "Channel or chat"), type: "text", required: true, placeholder: T("@moncanal ou -1001234567890", "@mychannel or -1001234567890"),
    hint: T("Pour un canal, ajoute le bot comme administrateur. Canal public : @nom. Canal privé : l'identifiant numérique (il commence par -100).",
      "For a channel, add the bot as an administrator. Public channel: @name. Private channel: the numeric id (starts with -100).") },
];

const KIND: ItemKind = {
  id: "telegram",
  label: T("Telegram", "Telegram"),
  // Montré en haut du formulaire « Ajouter » : les étapes, et la sécurité au bon moment. Guide complet : docs/guide/notifications.md.
  description: T(
    "1. Dans Telegram, écris à @BotFather : /newbot. Il te donne un jeton : colle-le ci-dessous.\n"
    + "2. Dans ton canal : Administrateurs → Ajouter un administrateur → ton bot. Coche SEULEMENT « Publier des messages ».\n"
    + "3. Mets le canal ci-dessous, puis « Essayer » : un message de test arrive dans le canal.\n"
    + "Sécurité : seuls les administrateurs publient dans un canal. Garde le canal privé (ta veille dit ce qui t'intéresse). Chez @BotFather, /setjoingroups → Disable : personne ne pourra mettre ton bot ailleurs. Jeton volé ? /revoke chez @BotFather, puis colle le nouveau ici.",
    "1. In Telegram, message @BotFather: /newbot. It gives you a token: paste it below.\n"
    + "2. In your channel: Administrators → Add admin → your bot. Tick ONLY “Post messages”.\n"
    + "3. Enter the channel below, then “Try”: a test message arrives in the channel.\n"
    + "Security: only admins post in a channel. Keep the channel private (your news watch tells what interests you). At @BotFather, /setjoingroups → Disable: nobody can add your bot elsewhere. Token stolen? /revoke at @BotFather, then paste the new one here.",
  ),
  fields: FIELDS,
  cloud: true,
};

const TEST_TEXT = T("Test de Floppy : ce canal est prêt.", "Floppy test: this channel is ready.");

/** « moncanal », « t.me/moncanal » -> « @moncanal » ; un identifiant numérique reste tel quel. */
function cleanChat(raw: unknown): string {
  let c = String(raw ?? "").trim();
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/?$/i.exec(c);
  if (m) c = m[1]!;
  if (/^-?\d+$/.test(c) || c.startsWith("@") || c === "") return c;
  return /^[A-Za-z0-9_]+$/.test(c) ? `@${c}` : c;
}

function clean(v: Record<string, unknown>): Values {
  return { label: String(v.label ?? "").trim(), chat: cleanChat(v.chat) };
}

/** Envoie le message découpé en morceaux de 4000 caractères au plus. */
export async function sendTelegram(f: FetchLike, token: string, chat: string, msg: NotifyMessage, signal: AbortSignal): Promise<void> {
  for (const text of telegramMessages(msg.title, msg.markdown)) {
    await callTelegram(f, token, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }, signal);
  }
}

export function createTelegramPlugin(fetchImpl?: FetchLike) {
  return definePlugin<Config>({
    manifest: {
      id: "notify-telegram",
      version: "0.1.0",
      licence: "MIT",
      sections: [
        { id: "notifications", label: T("Notifications", "Notifications"),
          description: T("Où Floppy peut envoyer des résultats : Telegram, mail…", "Where Floppy can send results: Telegram, mail…") },
      ],
      description: "Envoie des résultats dans un canal ou une discussion Telegram (bot), jeton dans le coffre.",
      provides: ["notify"],
      permissions: { net: ["api.telegram.org"], cloud: true },
      addable: {
        section: "notifications", label: T("Telegram", "Telegram"),
        description: T("Un bot Telegram qui écrit dans un canal ou une discussion.", "A Telegram bot that writes in a channel or chat."),
        cloud: true, single: true,
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const store = ctx.items.store();
      const secret = itemSecret(ctx, (id) => `notify-telegram/${id}/token`);
      const all = (): Entry[] => Object.entries(store.merge({}))
        .map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>), id }));
      const changed = () => ctx.items.changed();
      const signal = () => AbortSignal.timeout(cfg.timeout_s * 1000);
      // Tests : faux réseau. Sinon ctx.fetch, avec la même borne que `signal` (timeout_s, 15 s par défaut) pour chaque requête.
      const doFetch: FetchLike = fetchImpl ?? ((url, init) => ctx.fetch(url, { ...init, timeoutMs: cfg.timeout_s * 1000 }));
      /** Langue de l'assistant : le message de test envoyé dans le canal. */
      const lang = () => ctx.assistant.language;

      ctx.offer("notify", {
        items: () => all().filter((d) => store.isEnabled(d.id)).map((d) => ({ id: d.id, label: `Telegram · ${d.label}`, cloud: true })),
        start(f, id) {
          const d = all().find((x) => x.id === id && store.isEnabled(x.id));
          if (!d) throw new TextError(T(`destination Telegram inconnue ou désactivée : ${id}`, `unknown or disabled Telegram destination: ${id}`));
          f.provide("notify", {
            label: `Telegram · ${d.label}`, cloud: true,
            async send(msg, opts) {
              const token = secret.get(d.id);
              if (!token) throw new TextError(T(`Telegram « ${d.label} » : pas de jeton de bot. Ajoute-le dans les réglages.`, `Telegram "${d.label}": no bot token. Add it in the settings.`));
              const signals = [signal(), ...(opts?.signal ? [opts.signal] : [])];
              await sendTelegram(doFetch, token, d.chat, msg, AbortSignal.any(signals));
            },
          });
        },
      });

      const info = (d: Entry): ItemInfo => {
        const on = store.isEnabled(d.id);
        const hasToken = secret.has(d.id);
        return {
          id: d.id, label: d.label, kind: "telegram", enabled: on, cloud: true,
          detail: `Telegram · ${d.chat}`,
          status: !on ? "off" : hasToken ? "ok" : "warn",
          statusText: !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
            : hasToken ? undefined : T("pas de jeton de bot", "no bot token"),
          values: { ...d, token: secret.shown(d.id) } as unknown as Record<string, unknown>,
          editable: true, removable: true, toggleable: true,
          actions: [
            { id: "test", label: T("Envoyer un test", "Send a test") },
            { id: "chats", label: T("Trouver l'id", "Find the id") },
          ],
        };
      };


      const check = (v: Values): Text | undefined => {
        if (!v.label) return T("Il faut un nom.", "A name is required.");
        if (!v.chat) return T("Il faut le canal ou la discussion (ex. @moncanal).", "The channel or chat is required (e.g. @mychannel).");
        return undefined;
      };

      const sendTest = async (token: string | undefined, chat: string): Promise<OpResult> => {
        if (!token) return { ok: false, text: T("Il faut le jeton du bot.", "The bot token is required.") };
        try {
          await sendTelegram(doFetch, token, chat, { title: "", markdown: tr(TEST_TEXT, lang()) }, signal());
          return { ok: true, text: T("Ça marche : le message de test est parti.", "It works: the test message was sent.") };
        } catch (e) {
          return { ok: false, text: errorText(e) };
        }
      };

      ctx.items.declare({
        id: "notify-telegram", section: "notifications", order: 10, offers: "notify",
        label: T("Telegram", "Telegram"),
        description: T("Des canaux ou discussions Telegram où Floppy peut écrire. Les textes partent dans le cloud.", "Telegram channels or chats Floppy can write to. Texts go to the cloud."),
        addLabel: T("Ajouter un canal Telegram", "Add a Telegram channel"),
        badge: T("cloud", "cloud"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values): Promise<OpResult> => {
          if (kind !== "telegram") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
          const v = clean(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          const id = store.add("telegram", v as unknown as Record<string, unknown>, v.label, []);
          secret.apply(id, values.token);
          changed();
          return { ok: true, id, text: T(`${v.label} ajouté.`, `${v.label} added.`) };
        },
        update: async (id, values) => {
          const cur = all().find((d) => d.id === id);
          if (!cur) return { ok: false, text: T(`Destination inconnue : ${id}`, `Unknown destination: ${id}`) };
          const v = clean({ ...cur, ...values });
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          store.update(id, v as unknown as Record<string, unknown>);
          secret.apply(id, values.token);
          changed();
          return { ok: true, id, text: T(`${v.label} modifié.`, `${v.label} updated.`) };
        },
        remove: async (id) => {
          const cur = all().find((d) => d.id === id);
          if (!cur) return { ok: false, text: T(`Destination inconnue : ${id}`, `Unknown destination: ${id}`) };
          store.remove(id);
          secret.remove(id);
          changed();
          return { ok: true, text: T(`${cur.label} supprimé.`, `${cur.label} removed.`) };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((d) => d.id === id);
          if (!cur) return { ok: false, text: T(`Destination inconnue : ${id}`, `Unknown destination: ${id}`) };
          store.setEnabled(id, on);
          changed();
          return { ok: true, text: on ? T(`${cur.label} activé.`, `${cur.label} enabled.`) : T(`${cur.label} désactivé : Floppy ne le voit plus (rien n'est supprimé).`, `${cur.label} disabled: Floppy no longer sees it (nothing deleted).`) };
        },
        test: async (_kind, values, id): Promise<OpResult> => {
          const v = clean(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          const typed = values.token;
          const token = secret.typedOr(id, typed);
          return sendTest(token, v.chat);
        },
        action: async (id, action): Promise<OpResult> => {
          const cur = all().find((d) => d.id === id);
          if (!cur) return { ok: false, text: T(`Destination inconnue : ${id}`, `Unknown destination: ${id}`) };
          const token = secret.get(id);
          if (action === "test") return sendTest(token, cur.chat);
          if (action === "chats") {
            if (!token) return { ok: false, text: T("Il faut d'abord le jeton du bot.", "The bot token is needed first.") };
            try {
              const r = await callTelegram(doFetch, token, "getUpdates", { limit: 100, allowed_updates: [] }, signal());
              const seen = new Map<string, string | undefined>();
              for (const u of Array.isArray(r.result) ? (r.result as Record<string, unknown>[]) : []) {
                for (const part of Object.values(u)) {
                  const chat = (part as { chat?: { id?: number; title?: string; username?: string; first_name?: string } } | null)?.chat;
                  if (chat?.id === undefined) continue;
                  seen.set(String(chat.id), chat.title ?? chat.username ?? chat.first_name);
                }
              }
              if (!seen.size) return { ok: true, text: T("Aucune discussion vue. Ajoute le bot au canal (ou écris-lui un message), puis réessaie.", "No chat seen. Add the bot to the channel (or send it a message), then try again.") };
              return { ok: true, text: T(
                [...seen].map(([cid, name]) => `${name ?? "sans nom"} : ${cid}`).join("\n"),
                [...seen].map(([cid, name]) => `${name ?? "no name"}: ${cid}`).join("\n"),
              ) };
            } catch (e) {
              return { ok: false, text: errorText(e) };
            }
          }
          return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
        },
      });
    },
  });
}

export default createTelegramPlugin();
