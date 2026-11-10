// Appel à l'API des bots Telegram, partagé par le canal d'envoi (notify-telegram) et le corps (body-telegram).
// Les erreurs sont des TextError claires, en français et en anglais ; le jeton n'apparaît jamais dans un texte.
import { T, TextError, type Text } from "@floppy/core";

export { toTelegramHtml, toTelegramBlocks, telegramMessages, esc, MAX_MESSAGE } from "./telegram-markdown.ts";

/** Refus de Telegram, avec son code HTTP (401 jeton refusé, 409 un autre programme lit déjà les messages du bot…). */
export class TelegramError extends TextError {
  readonly status: number;
  constructor(status: number, text: Text) {
    super(text);
    this.status = status;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TgReply { ok?: boolean; description?: string; error_code?: number; result?: unknown }

/**
 * Appelle l'API Telegram. Rend la réponse décodée ; sinon lève une erreur claire (TextError, français et anglais ;
 * le jeton n'apparaît jamais dans le texte).
 */
export async function callTelegram(f: FetchLike, token: string, method: string, body: unknown, signal: AbortSignal): Promise<TgReply> {
  let r: Response;
  try {
    r = await f(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) {
    if (signal.aborted && (e as Error)?.name !== "TimeoutError") throw new TextError(T("Envoi Telegram annulé.", "Telegram sending cancelled."));
    throw new TextError(T("Telegram injoignable : vérifie la connexion internet.", "Telegram unreachable: check the internet connection."));
  }
  let data: TgReply = {};
  try { data = (await r.json()) as TgReply; } catch { /* pas du JSON */ }
  if (r.ok && data.ok !== false) return data;
  const status = r.status;
  const why = String(data.description ?? "").toLowerCase();
  if (status === 401) throw new TelegramError(status, T("Telegram : jeton refusé. Vérifie le jeton du bot.", "Telegram: token refused. Check the bot token."));
  if (status === 400 && why.includes("chat not found")) {
    throw new TelegramError(status, T(
      "Telegram : canal introuvable. Ajoute le bot comme administrateur du canal et vérifie le nom ou l'identifiant.",
      "Telegram: channel not found. Add the bot as an administrator of the channel and check the name or id.",
    ));
  }
  if (status === 403) throw new TelegramError(status, T("Telegram : le bot n'a pas le droit d'écrire ici.", "Telegram: the bot is not allowed to write here."));
  if (status === 429) throw new TelegramError(status, T("Telegram : trop d'envois d'un coup, réessaie dans un moment.", "Telegram: too many messages at once, try again in a moment."));
  if (status === 400) {
    const d = data.description ? String(data.description).replace(/bot\d+:[\w-]+/g, "bot…") : undefined;
    throw new TelegramError(status, T(`Telegram a refusé le message : ${d ?? "demande invalide"}`, `Telegram refused the message: ${d ?? "invalid request"}`));
  }
  if (status === 409) throw new TelegramError(status, T("Telegram : un autre programme lit déjà les messages de ce bot.", "Telegram: another program is already reading this bot's messages."));
  throw new TelegramError(status, T(`Telegram répond avec une erreur ${status}.`, `Telegram answers with error ${status}.`));
}

