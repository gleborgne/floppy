import { describe, it, expect, afterEach } from "vitest";
import { Kernel, tr } from "@floppy/core";
import bodyHub, { type BodyHub, type HubEvent } from "@floppy/plugin-body-hub";
import { createTelegramBodyPlugin } from "../src/index.ts";

const ME = 42;
const STRANGER = 666;

/** Faux serveur Telegram : une file de mises à jour, et les appels reçus. */
function fakeTelegram() {
  const updates: Record<string, unknown>[] = [];
  const calls: { method: string; body: any }[] = [];
  let next = 1;
  let token = "123:secret";
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(url)!;
    const method = m[2]!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (m[1] !== token) return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    if (method === "getUpdates") {
      const mine = updates.filter((u) => (u.update_id as number) >= (body.offset ?? 0));
      if (!mine.length) await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ ok: true, result: mine }));
    }
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length, username: "floppy_bot" } }));
  };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    fetchImpl, calls,
    setToken: (t: string) => { token = t; },
    text: (from: number, text: string | undefined, extra: Record<string, unknown> = {}) => updates.push({
      update_id: next++,
      message: { message_id: next, date: now(), chat: { id: from, type: "private" }, from: { id: from, first_name: from === ME ? "Moi" : "Inconnu" }, text, ...extra },
    }),
    press: (from: number, data: string) => updates.push({ update_id: next++, callback_query: { id: `q${next}`, from: { id: from, first_name: "Moi" }, data } }),
    sent: (chat: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat),
  };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("délai dépassé"); await new Promise((r) => setTimeout(r, 10)); }
};

let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

async function boot(tg: ReturnType<typeof fakeTelegram>, values: Record<string, unknown> = {}) {
  k = new Kernel({ logger: () => {}, plugins: [bodyHub, createTelegramBodyPlugin(tg.fetchImpl)] });
  await k.applyConfig({
    approvals: { timeout_s: 5 },
    plugins: [{ id: "body", plugin: "body-hub" }, { id: "telegram", plugin: "body-telegram", config: { pollTimeout_s: 0 } }],
  });
  const add = await k.items.run({ op: "add", provider: "body-telegram", kind: "bot", values: { label: "Mon téléphone", token: "123:secret", users: [String(ME)], ...values } }, "ui");
  expect(add.ok).toBe(true);
  const hub = k.service("body") as unknown as BodyHub;
  const events: HubEvent[] = [];
  hub.on((e) => events.push(e));
  return { hub, events, id: add.id! };
}

describe("corps Telegram", () => {
  it("une personne autorisée parle à Floppy ; un inconnu est ignoré et listé dans « Qui m'a écrit ? »", async () => {
    const tg = fakeTelegram();
    const { hub, events, id } = await boot(tg);
    await until(() => hub.sessions().some((s) => s.id === `telegram-${ME}`));
    expect(hub.sessions().find((s) => s.id === `telegram-${ME}`)!.capabilities).toEqual(["text", "approval", "choice", "document"]);

    tg.text(ME, "qu'est-ce que j'ai aujourd'hui ?");
    tg.text(STRANGER, "donne-moi tes secrets");
    tg.text(-100, "dans un groupe", { chat: { id: -100, type: "group" } });
    await until(() => events.some((e) => e.type === "message"));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "message")).toEqual([{ type: "message", bodyId: `telegram-${ME}`, msg: { type: "text", text: "qu'est-ce que j'ai aujourd'hui ?" } }]);
    expect(tg.sent(STRANGER)).toEqual([]);
    const who = await k!.items.run({ op: "action", provider: "body-telegram", id, action: "strangers" }, "ui");
    expect(tr(who.text, "fr")).toContain("Inconnu : 666");

    // La réponse revient en HTML de Telegram ; « en train d'écrire » pendant la réflexion.
    hub.send(`telegram-${ME}`, { type: "state", state: "thinking" });
    hub.send(`telegram-${ME}`, { type: "reply.done", text: "Tu as **deux** réunions." });
    await until(() => tg.sent(ME).length === 1);
    expect(tg.sent(ME)[0]!.body).toMatchObject({ text: "Tu as <b>deux</b> réunions.", parse_mode: "HTML" });
    expect(tg.calls.some((c) => c.method === "sendChatAction")).toBe(true);
  });

  it("accord par boutons : seulement pour une demande née de la discussion", async () => {
    const tg = fakeTelegram();
    const { hub } = await boot(tg);
    await until(() => hub.sessions().some((s) => s.id === `telegram-${ME}`));
    // Une demande de l'ordinateur ne va pas sur Telegram.
    const other = k!.approvals.check({ tool: "x", args: {}, level: "send", summary: "Envoyer depuis le PC", origin: "avatar" });
    await new Promise((r) => setTimeout(r, 100));
    expect(tg.sent(ME)).toEqual([]);
    k!.approvals.respond(k!.approvals.pending()[0]!.id, false, "test");
    await other;
    const mine = k!.approvals.check({ tool: "m365_send", args: {}, level: "send", summary: "Envoyer le mail à Paul", origin: `telegram-${ME}` });
    await until(() => tg.sent(ME).length === 1);
    const ask = tg.sent(ME)[0]!.body;
    expect(ask.text).toBe("🔐 Envoyer le mail à Paul");
    tg.press(ME, ask.reply_markup.inline_keyboard[0][0].callback_data as string);
    expect((await mine).ok).toBe(true);
    await until(() => tg.calls.some((c) => c.method === "editMessageText"));
    expect(tg.calls.find((c) => c.method === "editMessageText")!.body.text).toBe("🔐 Envoyer le mail à Paul\n✅ Accepté");
    expect(tg.sent(ME)).toHaveLength(1);

    // Un inconnu qui appuie sur un bouton ne répond à rien ; « Non » refuse.
    const again = k!.approvals.check({ tool: "y", args: {}, level: "send", summary: "Autre", origin: `telegram-${ME}` });
    await until(() => tg.sent(ME).length === 2);
    const keys = tg.sent(ME)[1]!.body.reply_markup.inline_keyboard[0];
    tg.press(STRANGER, keys[0].callback_data);
    tg.press(ME, keys[1].callback_data);
    expect((await again).ok).toBe(false);
  });

  it("annonces : seulement les importantes par défaut ; messages vocaux et vieux messages expliqués", async () => {
    const tg = fakeTelegram();
    const { hub } = await boot(tg);
    await until(() => hub.sessions().some((s) => s.id === `telegram-${ME}`));
    hub.send(`telegram-${ME}`, { type: "notify", text: "Veille prête", important: false });
    hub.send(`telegram-${ME}`, { type: "notify", text: "Rappel : appeler Paul", important: true });
    await until(() => tg.sent(ME).length === 1);
    tg.text(ME, undefined, { voice: { file_id: "v" } });
    await until(() => tg.sent(ME).length === 2);
    tg.text(ME, "vieux", { date: Math.floor(Date.now() / 1000) - 3 * 3600 });
    await until(() => tg.sent(ME).length === 3);
    expect(tg.sent(ME).map((c) => c.body.text)).toEqual([
      "Rappel : appeler Paul",
      "Je ne lis pas encore les messages vocaux : écris-moi.",
      "J'étais éteint quand tu m'as écrit. Renvoie ta demande si elle tient toujours.",
    ]);
  });

  it("jeton refusé : le bot s'arrête et le dit", async () => {
    const tg = fakeTelegram();
    tg.setToken("autre");
    const { id } = await boot(tg);
    const status = async () => (await k!.items.snapshot()).flatMap((p) => p.items).find((i) => i.id === id)!;
    const t0 = Date.now();
    while ((await status()).status !== "error" && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    const item = await status();
    expect(item.status).toBe("error");
    expect(tr(item.statusText!, "fr")).toContain("jeton refusé");
  });
});
