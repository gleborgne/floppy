import { afterEach, describe, expect, it, vi } from "vitest";
import { Scan, daysPeriod, period } from "../src/query.ts";
import { graphFixture, json } from "./search-fixture.ts";

afterEach(() => vi.useRealTimers());
describe("périodes vocales communes", () => {
  it.each([
    [{ date: "demain" }, "2026-11-10T00:00", "2026-11-11T00:00"],
    [{ periode: "ce_matin" }, "2026-11-09T00:00", "2026-11-09T12:00"],
    [{ periode: "cet_apres_midi" }, "2026-11-09T12:00", "2026-11-09T18:00"],
    [{ periode: "cette_semaine" }, "2026-11-09T00:00", "2026-11-16T00:00"],
    [{ periode: "semaine_derniere" }, "2026-11-02T00:00", "2026-11-09T00:00"],
    [{ periode: "semaine_prochaine" }, "2026-11-16T00:00", "2026-11-23T00:00"],
    [{ periode: "ce_mois" }, "2026-11-01T00:00", "2026-12-01T00:00"],
    [{ depuis: "2026-11-06T14:00" }, "2026-11-06T14:00", "2026-11-09T15:30"],
  ] as const)("%j", (args, start, end) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-09T15:30"));
    expect(period(args)).toEqual({ start: new Date(start), end: new Date(end) });
  });
  it("rejette les combinaisons contradictoires et dates impossibles", () => {
    for (const args of [{ date: "today", periode: "ce_matin" }, { depuis: "today", debut: "today", fin: "today" }, { periode: "inconnue" }, { debut: "2026-11-08" }, { date: "2026-02-29" }]) expect(() => period(args)).toThrow();
    expect(() => daysPeriod({ date: "today", jours: 3 }, 14)).toThrow();
  });
});
describe("pagination bornée", () => {
  it("parcourt les liens entiers et transmet un signal borné", async () => {
    const { g, fetcher } = graphFixture((url) => url.searchParams.has("$skiptoken") ? json({ value: [{ id: "2" }] }) : json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque%2Btoken" }));
    const scan = new Scan();
    expect(await scan.pages(g, "me/messages")).toEqual([{ id: "1" }, { id: "2" }]);
    expect(scan.partial).toBe(false);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("opaque%2Btoken");
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("arrête les boucles sans annoncer un parcours complet", async () => {
    const { g, fetcher } = graphFixture(() => json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages" }));
    const scan = new Scan(); await scan.pages(g, "https://graph.microsoft.com/v1.0/me/messages");
    expect(scan.partial).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(scan.note("en")).toContain("Partial search");
  });
  it("ne transmet jamais le jeton à un lien de pagination externe", async () => {
    const { g, fetcher } = graphFixture(() => json({ value: [], "@odata.nextLink": "https://contoso.test/steal" }));
    await expect(new Scan().pages(g, "me/messages")).rejects.toThrow(/pagination/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("ne transforme pas une erreur d'une page suivante en résultat vide", async () => {
    const { g } = graphFixture((url) => url.search ? json({ error: { message: "panne" } }, 503) : json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?next=1" }));
    await expect(new Scan().pages(g, "me/messages")).rejects.toThrow(/503/);
  });
});
