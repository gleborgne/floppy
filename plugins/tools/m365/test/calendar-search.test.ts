import { afterEach, describe, expect, it, vi } from "vitest";
import { tr } from "@floppy/core";
import { calendarTools } from "../src/calendar.ts";
import { graphFixture, json } from "./search-fixture.ts";

afterEach(() => vi.useRealTimers());
const time = (local: string) => ({ dateTime: new Date(local).toISOString().replace(/Z$/, ""), timeZone: "UTC" });
const event = (id: string, start = "2026-11-11T10:00", end = "2026-11-11T11:00", overrides = {}) => ({ id, subject: "Point budget", start: time(start), end: time(end), organizer: { emailAddress: { name: "Alex" } }, attendees: [{ emailAddress: { name: "Sophie", address: "sophie@contoso.test" } }], location: { displayName: "Salle bleue" }, showAs: "busy", onlineMeeting: { joinUrl: "https://contoso.test/meeting" }, ...overrides });
describe("agenda vocal", () => {
  it("combine période, participant, organisateur, sujet et lieu avant max", async () => {
    const { g } = graphFixture((url) => {
      expect(url.searchParams.get("startDateTime")).toBe(new Date("2026-11-11T12:00").toISOString());
      return url.searchParams.has("page") ? json({ value: [event("target", "2026-11-11T14:00", "2026-11-11T15:00")] }) : json({ value: [event("other", undefined, undefined, { subject: "Autre" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page=2&startDateTime=" + encodeURIComponent(new Date("2026-11-11T12:00").toISOString()) });
    });
    const result = await calendarTools(g, 8)[0]!.handler({ debut: "2026-11-11T12:00", fin: "2026-11-11T18:00", participant: "Sophie", organisateur: "Alex", sujet: "budget", lieu: "bleue", max: 1 }, {});
    expect(tr(result.text)).toContain("[id target]"); expect(tr(result.text)).not.toContain("[id other]");
    expect(tr(result.text)).toContain("sophie@contoso.test"); expect(tr(result.text)).toContain("https://contoso.test/meeting");
    expect(tr(result.text, "en")).toContain("attendees");
  });
  it("prochain rendez-vous : exclut réunion commencée et annulation, filtre avant sélection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T10:30"));
    const { g } = graphFixture(() => json({ value: [event("started"), event("cancelled", "2026-11-11T11:00", "2026-11-11T12:00", { isCancelled: true }), event("wrong", "2026-11-11T12:00", "2026-11-11T13:00", { subject: "Déjeuner" }), event("next", "2026-11-11T14:00", "2026-11-11T15:00")] }));
    const result = await calendarTools(g, 8)[1]!.handler({ sujet: "budget", participant: "Sophie" }, {});
    expect(tr(result.text)).toContain("[id next]");
    expect(tr(result.text)).not.toMatch(/\[id (started|wrong|cancelled)\]/);
  });
  it("date + jours historique respecte les jours civils", async () => {
    const { g } = graphFixture((url) => {
      expect(url.searchParams.get("endDateTime")).toBe(new Date("2026-03-31T00:00").toISOString());
      return json({ value: [] });
    });
    expect((await calendarTools(g, 8)[0]!.handler({ date: "2026-03-28", jours: 3 }, {})).status).toBe("done");
  });
  it("créneaux libres : réunions qui se chevauchent, marge, événements libres et refusés", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T15:00"));
    const { g } = graphFixture(() => json({ value: [event("one", "2026-11-11T10:00", "2026-11-11T11:00"), event("two", "2026-11-11T10:30", "2026-11-11T12:00"), event("free", "2026-11-11T13:00", "2026-11-11T14:00", { showAs: "free" }), event("declined", "2026-11-11T14:00", "2026-11-11T15:00", { responseStatus: { response: "declined" } })] }));
    const result = await calendarTools(g, 8)[2]!.handler({ date: "2026-11-11", duree_min: 45, marge_min: 15 }, {});
    expect(result.status).toBe("done");
    expect(tr(result.text)).toContain("09:00 → 11/11/2026 09:45");
    expect(tr(result.text)).toContain("12:15 → 11/11/2026 18:00");
    expect(tr(result.text)).not.toContain("10:30");
  });
  it("créneaux : journée entière occupée, fin de semaine, période horaire et erreurs de saisie", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T15:00"));
    const { g } = graphFixture(() => json({ value: [event("allDay", "2026-11-11T00:00", "2026-11-12T00:00", { isAllDay: true })] }));
    const tool = calendarTools(g, 8)[2]!;
    expect(tr((await tool.handler({ date: "2026-11-11" }, {})).text)).toContain("(0/0");
    expect(tr((await tool.handler({ date: "2026-11-14" }, {})).text)).toContain("(0/0");
    expect(tr((await tool.handler({ date: "2026-11-14", weekend: true }, {})).text)).toContain("09:00");
    const afternoon = await tool.handler({ debut: "2026-11-12T14:00", fin: "2026-11-12T16:00" }, {});
    expect(tr(afternoon.text)).toContain("14:00 → 12/11/2026 16:00");
    for (const a of [{ heure_debut: "24:00" }, { heure_debut: "18:00", heure_fin: "09:00" }, { duree_min: 0 }, { marge_min: -1 }]) expect((await tool.handler(a, {})).status).toBe("failed");
  });
  it("ne garantit pas la disponibilité si le calendrier est partiel", async () => {
    let page = 0;
    const { g } = graphFixture(() => json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?page=${++page}` }));
    const result = await calendarTools(g, 8)[2]!.handler({ date: "2026-11-11" }, {});
    expect(result.status).toBe("unverified"); expect(tr(result.text, "en")).toContain("cannot be guaranteed");
  });
});
