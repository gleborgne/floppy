import { afterEach, describe, expect, it, vi } from "vitest";
import { tr } from "@floppy/core";
import { GraphAuth } from "../src/graph.ts";
import { unreadMailTool } from "../src/unread-mail.ts";

afterEach(() => { vi.useRealTimers(); });

/** Réponses HTTP simulées ; le filtre reçu détermine les mails et le décompte. */
function mailbox(options: { noCount?: boolean; fail?: boolean } = {}) {
  const mails = [
    { id: "old", receivedDateTime: new Date("2026-11-07T23:59").toISOString(), isRead: false },
    { id: "midnight", receivedDateTime: new Date("2026-11-08T00:00").toISOString(), isRead: false },
    { id: "morning", receivedDateTime: new Date("2026-11-08T09:00").toISOString(), isRead: false },
    { id: "read", receivedDateTime: new Date("2026-11-08T10:00").toISOString(), isRead: true },
    { id: "noon", receivedDateTime: new Date("2026-11-08T12:00").toISOString(), isRead: false },
    { id: "next", receivedDateTime: new Date("2026-11-09T00:00").toISOString(), isRead: false },
  ];
  const queries: URLSearchParams[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return json({ access_token: "token", expires_in: 3600 });
    expect(url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
    queries.push(url.searchParams);
    if (options.fail) return json({ error: { message: "indisponible" } }, 503);
    const filter = url.searchParams.get("$filter")!;
    const m = /^receivedDateTime ge (\S+)(?: and receivedDateTime lt (\S+))? and isRead eq false$/.exec(filter);
    expect(m).not.toBeNull();
    expect(url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(url.searchParams.get("$count")).toBe("true");
    const selected = mails.filter((mail) => !mail.isRead && new Date(mail.receivedDateTime) >= new Date(m![1]!) && (!m![2] || new Date(mail.receivedDateTime) < new Date(m![2])))
      .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    const top = Number(url.searchParams.get("$top"));
    return json({
      value: selected.slice(0, top),
      ...(options.noCount ? {} : { "@odata.count": selected.length }),
      ...(selected.length > top ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" } : {}),
    });
  });
  const graph = new GraphAuth({ get: () => "refresh", set: () => {}, clear: () => {} }, fetcher as typeof fetch);
  return { tool: unreadMailTool(graph, 8), queries, fetcher };
}

describe("mails non lus par date de réception", () => {
  it.each(["aujourd'hui", "aujourd’hui", "today", "2026-11-08"])("jour local %s, filtre avant limite et décompte complet", async (date) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T15:00"));
    const { tool, queries } = mailbox();
    const result = await tool.handler({ date, max: 1 }, {});
    expect(result.status).toBe("done");
    expect(tr(result.text)).toContain("3 mail(s) non lu(s)");
    expect(tr(result.text)).toContain("1 mail(s) affiché(s)");
    expect(tr(result.text)).toContain("[id noon]");
    expect(tr(result.text)).not.toMatch(/\[id (old|read|next)\]/);
    expect(tr(result.text)).toContain("08/11/2026 00:00 inclus au 09/11/2026 00:00 exclu");
    expect(tr(result.text, "en")).toContain("3 unread email(s)");
    expect(tr(result.text, "en")).toContain("local time");
    expect(queries).toHaveLength(1);
  });

  it.each(["hier", "yesterday"])("%s est calculé à l'heure locale de l'appel", async (date) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T00:05"));
    const { tool } = mailbox();
    const result = await tool.handler({ date }, {});
    expect(tr(result.text)).toContain("1 mail(s) non lu(s)");
    expect(tr(result.text)).toContain("[id old]");
  });

  it("plage de dates inclusive et matinée avec fin exclue", async () => {
    const { tool } = mailbox();
    const range = await tool.handler({ debut: "2026-11-07", fin: "2026-11-08" }, {});
    expect(tr(range.text)).toContain("4 mail(s) non lu(s)");
    expect(tr(range.text)).not.toContain("[id next]");
    const morning = await tool.handler({ debut: "2026-11-08T00:00", fin: "2026-11-08T12:00" }, {});
    expect(tr(morning.text)).toContain("2 mail(s) non lu(s)");
    expect(tr(morning.text)).toContain("[id midnight]");
    expect(tr(morning.text)).toContain("[id morning]");
    expect(tr(morning.text)).not.toContain("[id noon]");
  });

  it.each([
    ["2026-03-29", "2026-03-30"], ["2026-10-25", "2026-10-26"],
    ["2026-12-31", "2027-01-01"], ["2028-02-29", "2028-03-01"],
  ])("bornes civiles pour %s, y compris changement d'heure et de mois", async (date, nextDate) => {
    const { tool, queries } = mailbox();
    await tool.handler({ date }, {});
    const start = new Date(`${date}T00:00`);
    const end = new Date(`${nextDate}T00:00`);
    expect(queries[0]!.get("$filter")).toBe(`receivedDateTime ge ${start.toISOString()} and receivedDateTime lt ${end.toISOString()} and isRead eq false`);
  });

  it.each([
    { date: "2026-02-30" }, { date: "2026-13-01" }, { date: "" }, { date: "n'importe quand" },
    { date: "2026-11-08T12:00" }, { date: "2026-11-08", debut: "2026-11-08" },
    { debut: "2026-11-08" }, { fin: "2026-11-08" }, { debut: "2026-11-09", fin: "2026-11-07" },
    { debut: "2026-11-08T12:00", fin: "2026-11-08T12:00" },
    { debut: "2026-11-08T24:00", fin: "2026-11-09" },
    { debut: "2026-11-08T00:00Z", fin: "2026-11-09" },
  ])("refuse une période invalide sans élargir la recherche : %j", async (args) => {
    const { tool, fetcher } = mailbox();
    const result = await tool.handler(args, {});
    expect(result.status).toBe("failed");
    expect(tr(result.text, "en")).not.toBe(tr(result.text));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aucun résultat dans la période ; sans période conserve tous les non-lus", async () => {
    const { tool } = mailbox();
    const empty = await tool.handler({ date: "2026-11-10" }, {});
    expect(tr(empty.text)).toContain("Aucun mail non lu");
    expect(tr(empty.text)).toContain("10/11/2026");
    expect(tr(empty.text, "en")).toContain("No unread mail");
    const all = await tool.handler({}, {});
    expect(tr(all.text)).toContain("5 mail(s) non lu(s)");
    expect(tr(all.text)).toContain("[id old]");
    expect(tr(all.text)).toContain("[id next]");
  });

  it("ne confond pas une page avec le total si Graph omet le décompte", async () => {
    const { tool } = mailbox({ noCount: true });
    const page = await tool.handler({ date: "2026-11-08", max: 1 }, {});
    expect(tr(page.text)).toContain("Décompte total indisponible");
    expect(tr(page.text)).not.toContain("1 mail(s) non lu(s)");
    const complete = await tool.handler({ date: "2026-11-08" }, {});
    expect(tr(complete.text)).toContain("3 mail(s) non lu(s)");
  });

  it("une erreur Graph n'est pas interprétée comme aucun mail", async () => {
    const { tool } = mailbox({ fail: true });
    expect((await tool.handler({ date: "2026-11-08" }, {})).status).toBe("failed");
  });
});
