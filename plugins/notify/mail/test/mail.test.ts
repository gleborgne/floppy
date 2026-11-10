import { describe, it, expect, afterEach } from "vitest";
import { Kernel, SECRET_SET, definePlugin } from "@floppy/core";
import type { NotifyService } from "@floppy/contracts";
import { createMailPlugin, mailError, mailHtml, type Transport, type TransportOptions } from "../src/index.ts";

describe("mailHtml", () => {
  it("met le Markdown en HTML avec des styles en ligne", () => {
    const h = mailHtml("Veille du jour", "## Titre\n\nUn **gras** et un [lien](https://a.fr/x).\n\n- un\n- deux");
    expect(h).toContain("max-width:680px");
    expect(h).toContain("<strong>gras</strong>");
    expect(h).toContain('<a href="https://a.fr/x" style=');
    expect(h).toContain("<li>un</li>");
    expect(h).not.toContain("<style");
  });

  it("échappe le titre et le HTML brut", () => {
    const h = mailHtml("<script>x</script> & co", "<img src=x onerror=alert(1)> et <b>gras</b>");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;x&lt;/script&gt; &amp; co");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<b>");
  });

  it("javascript: n'est pas un lien ; les adresses nues deviennent des liens", () => {
    const h = mailHtml("t", "[clic](javascript:alert(1)) et https://exemple.fr/page et [écris](mailto:a@b.fr)");
    expect(h).not.toMatch(/href="javascript:/i);
    expect(h).toContain('href="https://exemple.fr/page"');
    expect(h).toContain('href="mailto:a@b.fr"');
  });

  it("met un cadre aux tableaux", () => {
    const h = mailHtml("t", "| a | b |\n|---|---|\n| 1 | 2 |");
    expect(h).toMatch(/<table style="[^"]*border/);
    expect(h).toMatch(/<td style="[^"]*border/);
  });
});

describe("mailError", () => {
  it("traduit les erreurs en français", () => {
    expect(mailError({ code: "EAUTH" }).message).toMatch(/mot de passe d'application refusé/);
    expect(mailError({ responseCode: 535 }).message).toMatch(/refusé/);
    expect(mailError({ code: "ETIMEDOUT" }).message).toMatch(/injoignable/);
    expect(mailError({ code: "ECONNECTION" }).message).toMatch(/injoignable/);
    expect(mailError(new Error("bizarre")).message).toMatch(/envoi impossible \(bizarre\)/);
  });
});

// ---------------------------------------------------------------- noyau
interface Sent { from: string; to: string; subject: string; html: string; text: string }
let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

function setup(fail?: { code?: string; message?: string }) {
  const sent: Sent[] = [];
  const opts: TransportOptions[] = [];
  const factory = (o: TransportOptions): Transport => {
    opts.push(o);
    return {
      async sendMail(m) { if (fail) throw Object.assign(new Error(fail.message ?? "échec"), fail); sent.push(m); },
      async verify() { if (fail) throw Object.assign(new Error(fail.message ?? "échec"), fail); },
    };
  };
  let notify: { value: string; label: unknown }[] = [];
  let send: (() => Promise<void>) | undefined;
  const consumer = definePlugin({
    manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["notify"] },
    async apply(ctx) {
      send = async () => {
        notify = ctx.offers("notify");
        const b = await ctx.borrowItem<NotifyService>("notify", notify[0]!.value);
        try { await b!.service.send({ title: "Veille", markdown: "Du **texte** [ici](https://a.fr)" }); } finally { b?.release(); }
      };
    },
  });
  k = new Kernel({ logger: () => {}, plugins: [createMailPlugin(factory), consumer] });
  return { sent, opts, offers: () => notify, send: () => send!(), kernel: k };
}

const GMAIL = { label: "Gmail perso", fournisseur: "gmail", adresse: "moi@gmail.com", motdepasse: "abcd efgh ijkl mnop", destinataire: "" };

describe("notify-mail (noyau)", () => {
  it("ajoute une boîte Gmail et envoie par un consommateur notify", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "consumer", plugin: "consumer" }, { id: "mail", plugin: "notify-mail" }] });
    const r = await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    expect(r.ok).toBe(true);
    await s.send();
    expect(s.offers()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ from: "moi@gmail.com", to: "moi@gmail.com", subject: "Veille" });
    expect(s.sent[0]!.text).toBe("Du **texte** [ici](https://a.fr)");
    expect(s.sent[0]!.html).toContain('<a href="https://a.fr"');
    expect(s.opts[0]).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "moi@gmail.com", pass: "abcd efgh ijkl mnop" } });
  });

  it("serveur « autre » et destinataire différent", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "consumer", plugin: "consumer" }, { id: "mail", plugin: "notify-mail" }] });
    await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: { ...GMAIL, fournisseur: "autre", serveur: "smtp.x.fr", port: 587, securite: "starttls", destinataire: "toi@x.fr" } }, "ui");
    await s.send();
    expect(s.opts[0]).toMatchObject({ host: "smtp.x.fr", port: 587, secure: false });
    expect(s.sent[0]!.to).toBe("toi@x.fr");
  });

  it("le mot de passe n'est jamais dans les valeurs (SECRET_SET)", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    const p = (await s.kernel.items.snapshot()).find((x) => x.id === "notify-mail")!;
    expect(p.items).toHaveLength(1);
    expect(p.items[0]!.values).toMatchObject({ motdepasse: SECRET_SET });
    expect(p.items[0]!.detail).toBe("Gmail · moi@gmail.com → moi@gmail.com");
    expect(p.items[0]!.status).toBe("ok");
    expect(JSON.stringify(p)).not.toContain("abcd efgh");
  });

  it("sans mot de passe : avertissement ; refuse une adresse invalide", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    expect((await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: { ...GMAIL, adresse: "nimporte" } }, "ui")).ok).toBe(false);
    await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: { ...GMAIL, motdepasse: "" } }, "ui");
    const p = (await s.kernel.items.snapshot()).find((x) => x.id === "notify-mail")!;
    expect(p.items[0]!.status).toBe("warn");
  });

  it("test : vérifie la connexion sans envoyer ; mot de passe refusé en français", async () => {
    const ok = setup();
    await ok.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    const r = await ok.kernel.items.run({ op: "test", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    expect(r).toMatchObject({ ok: true, text: "Connexion au serveur réussie." });
    expect(ok.sent).toHaveLength(0);
    await ok.kernel.stopAll();

    const ko = setup({ code: "EAUTH", message: "535 bad credentials abcd efgh ijkl mnop" });
    await ko.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    const r2 = await ko.kernel.items.run({ op: "test", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    expect(r2.ok).toBe(false);
    expect(r2.text).toMatch(/mot de passe d'application refusé/);
    expect(r2.text).not.toContain("abcd");
  });

  it("action « Envoyer un mail de test » envoie vraiment un mail", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    const add = await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    const r = await s.kernel.items.run({ op: "action", provider: "notify-mail", id: add.id!, action: "test-mail" }, "ui");
    expect(r.ok).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.subject).toMatch(/test/i);
  });

  it("en anglais : mail de test et pied de page dans la langue de l'assistant", async () => {
    const s = setup();
    await s.kernel.applyConfig({ plugins: [{ id: "mail", plugin: "notify-mail" }] });
    await s.kernel.settings.change("langue_assistant", "en", "ui");
    await s.kernel.settings.change("langue_interface", "en", "ui");
    await s.kernel.idle();
    const add = await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    expect(add.text).toBe("Gmail perso added.");
    const r = await s.kernel.items.run({ op: "action", provider: "notify-mail", id: add.id!, action: "test-mail" }, "ui");
    expect(r.text).toBe("Test email sent to moi@gmail.com.");
    expect(s.sent[0]!.subject).toBe("Floppy test email");
    expect(s.sent[0]!.html).toContain("Sent by Floppy");
    expect(mailError({ code: "EAUTH" }).text).toEqual({ fr: "Mail : adresse ou mot de passe d'application refusé.", en: "Mail: address or app password refused." });
  });

  it("l'envoi qui échoue lève une erreur française", async () => {
    const s = setup({ code: "ETIMEDOUT" });
    await s.kernel.applyConfig({ plugins: [{ id: "consumer", plugin: "consumer" }, { id: "mail", plugin: "notify-mail" }] });
    await s.kernel.items.run({ op: "add", provider: "notify-mail", kind: "smtp", values: GMAIL }, "ui");
    await expect(s.send()).rejects.toThrow(/serveur mail injoignable/);
  });
});
