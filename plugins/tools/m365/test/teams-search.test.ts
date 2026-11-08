import { afterEach, describe, expect, it, vi } from "vitest";
import { tr } from "@floppy/core";
import { teamsReadTools } from "../src/teams-read.ts";
import { channelReadTool } from "../src/channel-search.ts";
import { graphFixture, json } from "./search-fixture.ts";

afterEach(() => vi.useRealTimers());
const person = { userId: "sophie", displayName: "Sophie Martin", email: "sophie@contoso.test" };
const chat = (id: string, overrides = {}) => ({ id, chatType: "oneOnOne", members: [{ userId: "me", displayName: "Moi" }, person], viewpoint: { lastMessageReadDateTime: "2026-11-08T08:00Z" }, ...overrides });
const msg = (id: string, overrides = {}) => ({ id, messageType: "message", createdDateTime: "2026-11-08T10:00Z", from: { user: { id: "sophie", displayName: "Sophie Martin" } }, body: { content: "Le budget https://contoso.test/doc" }, ...overrides });
function setup(route?: (url: URL) => Response) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T15:00"));
  const { g, fetcher } = graphFixture((url) => {
    if (url.pathname === "/v1.0/me") return json({ id: "me" });
    return route?.(url) ?? json({ value: [] });
  });
  const tools = teamsReadTools(g, 8, new Map());
  return { g, fetcher, tool: (name: string) => tools.find((t) => t.name === name)! };
}
describe("recherches vocales Teams", () => {
  it("cherche au-delà de la première page en combinant période, groupe, auteur, lien, pièce jointe et mention", async () => {
    const { tool } = setup((url) => {
      if (url.pathname.endsWith("/me/chats")) return json({ value: [chat("group", { chatType: "group", topic: "Projet Voix" })] });
      return url.searchParams.has("page") ? json({ value: [msg("target", { attachments: [{ name: "budget.pdf" }], mentions: [{ mentioned: { user: { id: "me" } } }] })] }) : json({ value: [msg("newer", { createdDateTime: "2026-11-09T12:00Z" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/group/messages?page=2" });
    });
    const result = await tool("m365_messages_teams").handler({ date: "2026-11-08", conversation: "Projet Voix", personne: "Sophie", sens: "recus", contient: "budget", avec_lien: true, avec_piece_jointe: true, mentions_moi: true, max: 1 }, {});
    expect(tr(result.text)).toContain("[message id target]"); expect(tr(result.text)).not.toContain("[message id newer]");
    expect(tr(result.text, "en")).toContain("mentions you");
  });
  it("sens envoyés et reçus, sans personne obligatoire", async () => {
    const { tool } = setup((url) => url.pathname.endsWith("/me/chats") ? json({ value: [chat("c")] }) : json({ value: [msg("mine", { from: { user: { id: "me" } } }), msg("hers")] }));
    const t = tool("m365_messages_teams");
    const mine = tr((await t.handler({ sens: "envoyes" }, {})).text);
    expect(mine).toContain("[message id mine]"); expect(mine).not.toContain("[message id hers]");
    const hers = tr((await t.handler({ sens: "recus" }, {})).text);
    expect(hers).toContain("[message id hers]"); expect(hers).not.toContain("[message id mine]");
  });
  it("refuse un prénom ambigu avant de lire les messages", async () => {
    const { tool, fetcher } = setup(() => json({ value: [chat("a"), chat("b", { members: [{ ...person, userId: "other", displayName: "Sophie Dupont" }] })] }));
    const result = await tool("m365_messages_teams").handler({ personne: "Sophie" }, {});
    expect(result.status).toBe("failed"); expect(tr(result.text)).toContain("Sophie Dupont");
    expect(fetcher.mock.calls.some((x) => String(x[0]).includes("/messages"))).toBe(false);
  });
  it("filtre les non-lus par watermark même si le dernier message est de moi ; signale les états inconnus", async () => {
    const { tool } = setup((url) => url.pathname.endsWith("/me/chats") ? json({ value: [chat("known", { lastMessagePreview: msg("mine", { from: { user: { id: "me" } } }) }), chat("unknown", { viewpoint: undefined })] }) : json({ value: [msg("unread"), msg("read", { createdDateTime: "2026-11-08T07:00Z" })] }));
    const result = await tool("m365_teams_non_lus").handler({ date: "2026-11-08" }, {});
    expect(tr(result.text)).toContain("[message id unread]"); expect(tr(result.text)).not.toContain("[message id read]");
    expect(tr(result.text)).toContain("État de lecture inconnu");
  });
  it("une erreur de lecture n'est jamais interprétée comme aucun message", async () => {
    const { tool } = setup((url) => url.pathname.endsWith("/me/chats") ? json({ value: [chat("c")] }) : json({ error: { message: "panne" } }, 503));
    const result = await tool("m365_messages_teams").handler({}, {});
    expect(result.status).toBe("failed"); expect(tr(result.text)).toContain("503");
  });
  it("le repli d'expansion conserve les membres sans prétendre connaître les non-lus", async () => {
    const { tool } = setup((url) => url.searchParams.get("$expand")?.includes("lastMessagePreview") ? json({ error: { message: "expansion refusée" } }, 400) : json({ value: [chat("c", { viewpoint: undefined })] }));
    const result = await tool("m365_conversations_teams").handler({}, {});
    expect(result.status).toBe("done"); expect(tr(result.text)).toContain("lecture inconnue"); expect(tr(result.text)).toContain("Sophie Martin");
  });
  it("signale la limite de conversations sans faire croire à un total exhaustif", async () => {
    const { tool } = setup((url) => url.pathname.endsWith("/me/chats") ? json({ value: Array.from({ length: 11 }, (_, i) => chat(`c${i}`)) }) : json({ value: [] }));
    expect(tr((await tool("m365_messages_teams").handler({}, {})).text)).toContain("Recherche partielle");
  });
  it("canal : retrouve une réponse récente dans un ancien fil et parcourt les réponses suivantes", async () => {
    const { g } = setup((url) => url.pathname.endsWith("/replies") ? json({ value: [msg("reply", { mentions: [{ mentioned: { user: { id: "me" } } }] })] }) : json({ value: [msg("root", { createdDateTime: "2026-01-01T00:00Z", body: { content: "Ancien contexte" }, replies: [], "replies@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/root/replies" })] }));
    const tool = channelReadTool(g, { authorize: async () => {}, me: async () => "me", resolve: async () => ({ team: { id: "t", displayName: "Projet" }, ch: { id: "c", displayName: "Général" } }) });
    const result = await tool.handler({ equipe: "Projet", date: "2026-11-08", contient: "budget", auteur: "Sophie", mentions_moi: true, avec_lien: true }, {});
    expect(tr(result.text)).toContain("[message id reply]"); expect(tr(result.text)).toContain("contexte du fil");
    expect(tr(result.text)).toContain("[message id root]"); expect(tr(result.text, "en")).toContain("thread context");
  });
});
