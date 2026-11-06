import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, TextError, definePlugin, type Context, type NotifyService } from "@floppy/core";
import { createTelegramPlugin, toTelegramHtml, telegramMessages } from "../src/index.ts";

describe("toTelegramHtml", () => {
  it("titres en gras, paragraphes séparés par une ligne vide", () => {
    expect(toTelegramHtml("# Titre\n\nUn texte.\n\n## Sous-titre\n\nAutre.")).toBe("<b>Titre</b>\n\nUn texte.\n\n<b>Sous-titre</b>\n\nAutre.");
  });

  it("gras, italique, barré, code", () => {
    expect(toTelegramHtml("**gras** *ital* ~~barré~~ `x < y`")).toBe("<b>gras</b> <i>ital</i> <s>barré</s> <code>x &lt; y</code>");
  });

  it("liens http(s) gardés, javascript: retiré (texte gardé)", () => {
    expect(toTelegramHtml("[ici](https://a.com/x?a=1&b=2)")).toBe('<a href="https://a.com/x?a=1&amp;b=2">ici</a>');
    expect(toTelegramHtml("[piège](javascript:alert(1))")).not.toContain("<a");
    expect(toTelegramHtml("[piège](javascript:alert(1))")).toContain("piège");
    expect(toTelegramHtml("voir https://exemple.org/page")).toBe('voir <a href="https://exemple.org/page">https://exemple.org/page</a>');
  });

  it("listes à puces et numérotées, imbriquées", () => {
    expect(toTelegramHtml("- un\n- deux\n  - sous")).toBe("• un\n• deux\n  • sous");
    expect(toTelegramHtml("3. trois\n4. quatre")).toBe("3. trois\n4. quatre");
  });

  it("échappe & < > et le HTML brut", () => {
    expect(toTelegramHtml("a & b <script>x</script>")).toBe("a &amp; b &lt;script&gt;x&lt;/script&gt;");
  });

  it("code en bloc, citation, saut de ligne, tableau, séparateur", () => {
    expect(toTelegramHtml("```js\nif (a<b) {}\n```")).toBe("<pre>if (a&lt;b) {}</pre>");
    expect(toTelegramHtml("> cité")).toBe("<blockquote>cité</blockquote>");
    expect(toTelegramHtml("ligne un  \nligne deux")).toBe("ligne un\nligne deux");
    expect(toTelegramHtml("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a | b\n1 | 2");
    expect(toTelegramHtml("un\n\n---\n\ndeux")).toContain("──────");
  });

  it("n'écrit que des balises permises", () => {
    const html = toTelegramHtml("# T\n\n**a** [l](https://x.y) ![img](https://x.y/i.png)\n\n- p\n\n> q\n\n| a |\n|---|\n| b |");
    for (const m of html.matchAll(/<\/?([a-z]+)/g)) expect(["b", "i", "u", "s", "a", "code", "pre", "blockquote"]).toContain(m[1]);
  });
});

describe("découpage", () => {
  it("un seul message court : titre en gras puis texte", () => {
    expect(telegramMessages("Veille <1>", "Bonjour")).toEqual(["<b>Veille &lt;1&gt;</b>\n\nBonjour"]);
  });

  it("coupe aux paragraphes, chaque morceau ≤ 4000 et balises équilibrées", () => {
    const para = (n: number) => `**Paragraphe ${n}** ` + "mot ".repeat(200);
    const md = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");
    const msgs = telegramMessages("Gros", md);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4000);
      expect((m.match(/<b>/g) ?? []).length).toBe((m.match(/<\/b>/g) ?? []).length);
    }
    expect(msgs.join("\n\n").match(/Paragraphe \d+/g)).toHaveLength(20);
  });

  it("un bloc de code énorme est coupé, chaque morceau reste dans <pre>", () => {
    const code = "```\n" + Array.from({ length: 800 }, (_, i) => `ligne ${i} <x>`).join("\n") + "\n```";
    const msgs = telegramMessages("", code);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4000);
      expect(m.startsWith("<pre>") && m.endsWith("</pre>")).toBe(true);
    }
  });

  it("une ligne géante sans espace reste ≤ 4000", () => {
    const msgs = telegramMessages("", "a&".repeat(5000));
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4000);
    expect(msgs.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------- noyau
const TOKEN = "123456:SECRET-token";
interface Call { url: string; body: any }
let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

async function setup(reply: (call: Call) => { status?: number; json?: unknown } | Error = () => ({ json: { ok: true, result: {} } })) {
  const calls: Call[] = [];
  const fake = async (url: string, init?: RequestInit) => {
    const call = { url, body: JSON.parse(String(init?.body ?? "null")) };
    calls.push(call);
    const r = reply(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? { ok: true }), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  let ctxRef!: Context;
  const consumer = definePlugin({
    manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["notify"] },
    apply(ctx) { ctxRef = ctx; },
  });
  const secrets = new MemorySecrets();
  k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "notify-tg-")), secrets, plugins: [createTelegramPlugin(fake), consumer] });
  await k.applyConfig({ plugins: [{ id: "tg", plugin: "notify-telegram" }, { id: "c", plugin: "consumer" }] });
  const add = (values: Record<string, unknown> = {}) =>
    k!.items.run({ op: "add", provider: "notify-telegram", kind: "telegram", values: { label: "Mon canal", token: TOKEN, chat: "moncanal", ...values } }, "ui");
  const send = async (value: string, markdown = "Salut") => {
    const b = await ctxRef.borrowItem<NotifyService>("notify", value);
    expect(b).toBeDefined();
    try { await b!.service.send({ titre: "Veille", markdown }); } finally { b!.release(); }
  };
  return { calls, secrets, add, send, ctx: () => ctxRef };
}

describe("plugin notify-telegram", () => {
  it("ajoute une destination, l'offre, envoie avec le bon corps", async () => {
    const s = await setup();
    const r = await s.add();
    expect(r.ok).toBe(true);
    await k!.applyConfig({ plugins: [{ id: "tg", plugin: "notify-telegram" }, { id: "c", plugin: "consumer" }] });
    const offers = s.ctx().offers("notify");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ label: "Telegram · Mon canal", cloud: true });
    await s.send(offers[0]!.value, "**Bonjour** [a](https://x.y)");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(s.calls[0]!.body).toEqual({
      chat_id: "@moncanal", parse_mode: "HTML", disable_web_page_preview: true,
      text: '<b>Veille</b>\n\n<b>Bonjour</b> <a href="https://x.y">a</a>',
    });
  });

  it("le jeton va dans le coffre, jamais dans la liste", async () => {
    const s = await setup();
    await s.add();
    const snap = (await k!.items.snapshot()).find((p) => p.id === "notify-telegram")!;
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
    expect(snap.items[0]).toMatchObject({ kind: "telegram", status: "ok", detail: "Telegram · @moncanal", cloud: true });
  });

  it("refuse un ajout incomplet", async () => {
    const s = await setup();
    const r = await s.add({ chat: "" });
    expect(r.ok).toBe(false);
  });

  it("essayer : envoie le message de test", async () => {
    const s = await setup();
    const r = await k!.items.run({ op: "test", provider: "notify-telegram", kind: "telegram", values: { label: "x", token: TOKEN, chat: "-1001234567890" } }, "ui");
    expect(r.ok).toBe(true);
    expect(s.calls[0]!.body).toMatchObject({ chat_id: "-1001234567890", text: "Test de Floppy : ce canal est prêt." });
  });

  it("messages d'erreur en français, sans le jeton", async () => {
    const cases: [{ status: number; json: unknown } | Error, RegExp][] = [
      [{ status: 401, json: { ok: false, description: "Unauthorized" } }, /jeton refusé/],
      [{ status: 400, json: { ok: false, description: "Bad Request: chat not found" } }, /canal introuvable.*administrateur/],
      [{ status: 403, json: { ok: false, description: "Forbidden" } }, /pas le droit d'écrire/],
      [new TypeError("fetch failed https://api.telegram.org/bot" + TOKEN), /Telegram injoignable/],
    ];
    for (const [reply, re] of cases) {
      await k?.stopAll();
      const s = await setup(() => reply);
      await s.add();
      await k!.applyConfig({ plugins: [{ id: "tg", plugin: "notify-telegram" }, { id: "c", plugin: "consumer" }] });
      const value = s.ctx().offers("notify")[0]!.value;
      let err = "";
      try { await s.send(value); } catch (e) { err = (e as Error).message; }
      expect(err).toMatch(re);
      expect(err).not.toContain(TOKEN);
    }
  });

  it("en anglais : message de test dans la langue de l'assistant, erreurs et réponses dans celle de l'interface", async () => {
    const s = await setup((c) => (c.body?.chat_id === "@absent" ? { status: 400, json: { ok: false, description: "Bad Request: chat not found" } } : { json: { ok: true } }));
    await k!.settings.change("langue_assistant", "en", "ui");
    await k!.settings.change("langue_interface", "en", "ui");
    await k!.idle();
    const r = await k!.items.run({ op: "test", provider: "notify-telegram", kind: "telegram", values: { label: "x", token: TOKEN, chat: "-100" } }, "ui");
    expect(r.text).toBe("It works: the test message was sent.");
    expect(s.calls.at(-1)!.body).toMatchObject({ text: "Floppy test: this channel is ready." });
    const bad = await k!.items.run({ op: "test", provider: "notify-telegram", kind: "telegram", values: { label: "x", token: TOKEN, chat: "@absent" } }, "ui");
    expect(bad.text).toMatch(/^Telegram: channel not found/);
    // Une erreur d'envoi reste en français dans `message` (journaux), en deux langues dans `text`.
    await s.add({ chat: "@absent" });
    await k!.applyConfig({ plugins: [{ id: "tg", plugin: "notify-telegram" }, { id: "c", plugin: "consumer" }] });
    let err: unknown;
    try { await s.send(s.ctx().offers("notify")[0]!.value); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TextError);
    expect((err as TextError).message).toMatch(/^Telegram : canal introuvable/);
    expect((err as TextError).text).toMatchObject({ en: expect.stringMatching(/^Telegram: channel not found/) });
  });

  it("action « Trouver l'id » liste les discussions vues", async () => {
    const s = await setup((c) => c.url.endsWith("getUpdates")
      ? { json: { ok: true, result: [{ update_id: 1, channel_post: { chat: { id: -1001, title: "Mon canal" } } }, { update_id: 2, message: { chat: { id: 42, first_name: "Guillaume" } } }] } }
      : { json: { ok: true } });
    const add = await s.add();
    const r = await k!.items.run({ op: "action", provider: "notify-telegram", id: add.id!, action: "chats" }, "ui");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Mon canal : -1001");
    expect(r.text).toContain("Guillaume : 42");
  });
});
