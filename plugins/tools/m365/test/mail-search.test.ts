import { describe, expect, it } from "vitest";
import { tr } from "@floppy/core";
import { mailSearchTools } from "../src/mail-search.ts";
import { graphFixture, json } from "./search-fixture.ts";

const mail = (id: string, overrides = {}) => ({ id, subject: "Budget final", from: { emailAddress: { name: "Sophie Martin", address: "sophie@contoso.test" } }, toRecipients: [{ emailAddress: { name: "Alex", address: "alex@contoso.test" } }], receivedDateTime: "2026-11-08T10:00:00Z", sentDateTime: "2026-11-08T09:59:00Z", body: { content: "<p>Budget approuvé : document confidentiel.</p>" }, isRead: false, hasAttachments: true, conversationId: "thread", ...overrides });
describe("recherches fines Outlook", () => {
  it("combine les filtres avant max et trouve un mail sur la deuxième page", async () => {
    const paths: URL[] = [];
    const { g } = graphFixture((url) => {
      paths.push(url);
      if (url.searchParams.has("page")) return json({ value: [mail("target")] });
      expect(url.searchParams.get("$filter")).toContain("isRead eq false and hasAttachments eq true");
      expect(url.searchParams.get("$filter")).toContain(new Date("2026-11-08T00:00").toISOString());
      return json({ value: [mail("wrong", { subject: "Autre sujet" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?page=2" });
    });
    const result = await mailSearchTools(g, 8)[0]!.handler({ date: "2026-11-08", expediteur: "Sophie", destinataire: "Alex", sujet: "budget", contient: "approuve", requete: "confidentiel", lecture: "non_lus", avec_piece_jointe: true, max: 1 }, {});
    expect(result.status).toBe("done");
    expect(tr(result.text)).toContain("[id target]");
    expect(tr(result.text)).not.toContain("[id wrong]");
    expect(tr(result.text, "en")).toContain("1 email(s) found");
    expect(paths).toHaveLength(2);
  });
  it("recherche sans mots obligatoires, dossier envoyés et tri ancien", async () => {
    const { g } = graphFixture((url) => {
      expect(url.pathname).toContain("mailFolders/sentitems/messages");
      expect(url.searchParams.get("$orderby")).toBe("sentDateTime asc");
      expect(url.searchParams.get("$filter")).toContain("sentDateTime ge");
      return json({ value: [mail("sent")] });
    });
    expect((await mailSearchTools(g, 8)[0]!.handler({ date: "2026-11-08", dossier: "envoyes", tri: "ancien", destinataire: "Alex" }, {})).status).toBe("done");
  });
  it("refuse un critère inconnu plutôt que de l'ignorer", async () => {
    const { g, fetcher } = graphFixture(() => json({ value: [] }));
    const result = await mailSearchTools(g, 8)[0]!.handler({ lecture: "important" }, {});
    expect(result.status).toBe("failed"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("utilise l'index Outlook sans période et vérifie les autres critères localement", async () => {
    const { g } = graphFixture((url) => {
      expect(url.searchParams.get("$search")).toBe('"subject:budget"');
      expect(url.searchParams.has("$filter")).toBe(false);
      expect(url.searchParams.has("$orderby")).toBe(false);
      return json({ value: [mail("read", { isRead: true }), mail("target", { receivedDateTime: "2020-01-01T12:00Z" })] });
    });
    const result = await mailSearchTools(g, 8)[0]!.handler({ sujet: "budget final", lecture: "non_lus", avec_piece_jointe: true }, {});
    expect(tr(result.text)).toContain("[id target]");
    expect(tr(result.text)).not.toContain("[id read]");
  });
  it("lecture du fil : reçus et envoyés, ordre chronologique et auteurs", async () => {
    const { g } = graphFixture((url) => {
      if (url.pathname.includes("/messages/root")) return json({ conversationId: "thread'quoted" });
      expect(url.searchParams.get("$filter")).toBe("conversationId eq 'thread''quoted'");
      return json({ value: [mail("reply", { sentDateTime: "2026-11-08T11:00Z", from: { emailAddress: { name: "Moi" } } }), mail("received")] });
    });
    const result = await mailSearchTools(g, 8)[1]!.handler({ id: "root" }, {});
    const text = tr(result.text);
    expect(text.indexOf("[id received]")).toBeLessThan(text.indexOf("[id reply]"));
    expect(text).toContain("Sophie Martin"); expect(text).toContain("Moi");
    expect(tr(result.text, "en")).toContain("Email thread");
  });
  it("signale un parcours limité et ne promet pas une absence exhaustive", async () => {
    let page = 0;
    const { g } = graphFixture(() => json({ value: [mail(`other${page}`, { subject: "Autre" })], "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?page=${++page}` }));
    const result = await mailSearchTools(g, 8)[0]!.handler({ sujet: "introuvable" }, {});
    expect(tr(result.text)).toContain("Recherche partielle");
    expect(tr(result.text)).toContain("0 mail(s) trouvé(s) dans la partie consultée");
    expect(page).toBe(10);
  });
});
