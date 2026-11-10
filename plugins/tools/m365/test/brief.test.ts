import { describe, it, expect } from "vitest";
import { calendarSection, mailSection } from "../src/brief.ts";
import { GraphAuth } from "../src/graph.ts";
import { graphFixture, json } from "./search-fixture.ts";

const NOW = new Date(2026, 10, 10, 8, 0);
const utc = (local: string) => new Date(local).toISOString().slice(0, 19);
const req = (extra: Partial<{ since: Date; lang: "fr" | "en" }> = {}) => ({ lang: "fr" as const, now: NOW, signal: AbortSignal.timeout(5000), ...extra });

describe("rubriques Microsoft 365 du point du matin", () => {
  it("agenda : de maintenant à minuit, sans les annulés ni les refusés, urgent si une réunion est proche", async () => {
    let asked = "";
    const { g } = graphFixture((url) => {
      asked = url.toString();
      return json({ value: [
        { subject: "Démo client", start: { dateTime: utc("2026-11-10T14:00") }, end: { dateTime: utc("2026-11-10T15:00") }, location: { displayName: "Salle B" } },
        { subject: "Point équipe", start: { dateTime: utc("2026-11-10T08:30") }, end: { dateTime: utc("2026-11-10T09:00") }, onlineMeeting: { joinUrl: "https://x" } },
        { subject: "Annulé", isCancelled: true, start: { dateTime: utc("2026-11-10T10:00") }, end: { dateTime: utc("2026-11-10T11:00") } },
        { subject: "Refusé", responseStatus: { response: "declined" }, start: { dateTime: utc("2026-11-10T11:00") }, end: { dateTime: utc("2026-11-10T12:00") } },
      ] });
    });
    const s = await calendarSection(g, req());
    expect(asked).toContain(encodeURIComponent(NOW.toISOString()));
    expect(s).toEqual({ title: "Agenda du jour", urgent: true, markdown: "- 08:30–09:00 : Point équipe (en ligne)\n- 14:00–15:00 : Démo client (Salle B)" });
    const { g: none } = graphFixture(() => json({ value: [] }));
    expect(await calendarSection(none, req({ lang: "en" }))).toMatchObject({ title: "Today's calendar", empty: true });
  });

  it("mails : non lus depuis le dernier point (3 jours au plus), importants en urgence", async () => {
    let filter = "";
    const { g } = graphFixture((url) => {
      filter = url.searchParams.get("$filter") ?? "";
      return json({ "@odata.count": 12, value: [{ subject: "Devis", from: { emailAddress: { name: "Paul" } }, importance: "high", bodyPreview: "Bonjour,\n le devis" }] });
    });
    const since = new Date(2026, 10, 9, 18, 0);
    const s = await mailSection(g, req({ since }));
    expect(filter).toBe(`receivedDateTime ge ${since.toISOString()} and isRead eq false`);
    expect(s.urgent).toBe(true);
    expect(s.markdown).toBe("12 mails non lus depuis hier 18:00 :\n- Paul : Devis [important] — « Bonjour, le devis »\n…et 11 autres.");
    // Un dernier point trop ancien : 24 h seulement.
    await mailSection(g, req({ since: new Date(2026, 9, 1) }));
    expect(filter).toContain(new Date(+NOW - 86_400_000).toISOString());
  });

  it("pas connecté : erreur claire", async () => {
    const g = new GraphAuth({ get: () => undefined, set: () => {}, clear: () => {} }, (async () => json({})) as typeof fetch);
    await expect(calendarSection(g, req())).rejects.toThrow(/pas connecté/);
  });
});
