import { describe, expect, it } from "vitest";
import { createAgentReferences, type AgentReference, type ReferenceDiagnostic } from "../src/references.ts";

const mail: AgentReference = { identity: "opaque-mail", label: "Filtrage des mails", project: "Floppy", aliases: ["mail filtering", "courrier"] };
const avatar: AgentReference = { identity: "opaque-avatar", label: "Réveil avatar", project: "Floppy", aliases: ["avatar wakeup", "Luna"] };
const memory: AgentReference = { identity: "opaque-memory", label: "Analyse mémoire", project: "Floppy", aliases: ["memory analysis", "dev-mcp"] };
const agents = [mail, avatar, memory];
function ids(result: ReturnType<ReturnType<typeof createAgentReferences>["resolve"]>) {
  return result.ok ? result.references.map((ref) => ref.identity) : result.reason;
}

describe("références par conversation", () => {
  it("révoque seulement le contexte encore détenu par cette annonce", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("voice", [mail], "a");
    refs.rememberPresented("chat", [avatar], "a");
    refs.revokeAnnouncement("voice", "a");
    expect(ids(refs.resolve("voice", agents))).toBe("no_context");
    expect(ids(refs.resolve("chat", agents))).toEqual([avatar.identity]);
    refs.rememberPresented("voice", [mail], "a");
    refs.focus("voice", avatar);
    refs.revokeAnnouncement("voice", "a");
    expect(ids(refs.resolve("voice", agents))).toEqual([avatar.identity]);
    refs.rememberPresented("voice", [mail], "a");
    refs.rememberPresented("voice", [memory], "b");
    refs.revokeAnnouncement("voice", "a");
    expect(ids(refs.resolve("voice", agents))).toEqual([memory.identity]);
  });

  it("isole les origines et ne choisit pas le seul agent vivant sans présentation", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("voice", [mail]);
    refs.rememberPresented("chat", [avatar]);
    expect(ids(refs.resolve("voice", agents))).toEqual([mail.identity]);
    expect(ids(refs.resolve("chat", agents))).toEqual([avatar.identity]);
    expect(ids(refs.resolve("other", [memory]))).toBe("no_context");
  });

  it("un relevé ou une notification silencieuse ne change jamais lui", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("voice", [mail]);
    const observed = [memory, avatar, mail];
    expect(ids(refs.resolve("voice", observed, { target: "lui" }))).toEqual([mail.identity]);
    expect(ids(refs.resolve("voice", [avatar, mail], { target: "it" }))).toEqual([mail.identity]);
  });

  it.each(["premier", "le premier", "première", "first", "the first", "1st", "1er"])("résout %s dans le groupe présenté", (target) => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    expect(ids(refs.resolve("v", [...agents].reverse(), { target }))).toEqual([mail.identity]);
  });

  it.each(["deuxième", "le deuxième", "second", "seconde", "the second", "2nd", "2e", "2ème"])("résout %s sans perdre l'ordre après un focus", (target) => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    refs.focus("v", memory);
    expect(ids(refs.resolve("v", [...agents].reverse(), { target }))).toEqual([avatar.identity]);
    expect(ids(refs.resolve("v", agents))).toEqual([avatar.identity]);
    expect(ids(refs.resolve("v", agents, { target: "premier" }))).toEqual([mail.identity]);
  });

  it("comprend un sujet puis garde son identité pour la question suivante", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    expect(ids(refs.resolve("v", agents, { target: "celui sur les mails" }))).toEqual([mail.identity]);
    const updated = { ...mail, label: "Tri terminé", status: "done" };
    const result = refs.resolve("v", [updated, avatar], { target: "il" });
    expect(result.ok && result.references[0]).toBe(updated);
    expect(ids(refs.resolve("v", [updated, avatar], { target: "Tri terminé" }))).toEqual([mail.identity]);
    expect(ids(refs.resolve("v", agents, { target: "him" }))).toEqual([mail.identity]);
  });

  it("échoue explicitement si le focus ou l'ordinal disparaît sans choisir un agent en attente", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    refs.focus("v", mail);
    const replacement = { ...mail, identity: "replacement" };
    expect(ids(refs.resolve("v", [replacement, avatar]))).toBe("missing");
    expect(ids(refs.resolve("v", [replacement, avatar], { target: "first" }))).toBe("missing");
    expect(ids(refs.resolve("v", [replacement, avatar], { target: "mails" }))).toBe("ambiguous");
  });

  it("ne confond pas projet et agent, même avec un focus précédent", () => {
    const refs = createAgentReferences();
    refs.focus("v", mail);
    expect(ids(refs.resolve("v", agents, { target: "Floppy" }))).toBe("ambiguous");
    expect(ids(refs.resolve("v", agents))).toEqual([mail.identity]);
    expect(ids(refs.resolve("v", agents, { target: "inconnu" }))).toBe("notfound");
  });

  it("tolère la dictée, donne priorité aux noms exacts et expose les collisions", () => {
    const refs = createAgentReferences();
    expect(ids(refs.resolve("v", agents, { target: "dev m c p" }))).toEqual([memory.identity]);
    expect(ids(refs.resolve("v", agents, { target: "Louna" }))).toEqual([avatar.identity]);
    expect(ids(refs.resolve("v", agents, { target: "the one about mail filtering" }))).toEqual([mail.identity]);
    const twin = { ...mail, identity: "twin", aliases: ["Luna"] };
    expect(ids(refs.resolve("v", [avatar, twin], { target: "Luna" }))).toBe("ambiguous");
    expect(ids(refs.resolve("v", [avatar, { ...twin, aliases: ["Louna"] }], { target: "Luna" }))).toEqual([avatar.identity]);
  });

  it("un groupe sans focus reste ambigu au singulier", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    expect(ids(refs.resolve("v", agents))).toBe("ambiguous");
    expect(ids(refs.resolve("v", agents, { target: "99th" }))).toBe("notfound");
  });

  it.each(["eux", "ils", "them", "all"])("garde un instantané pluriel pour %s", (target) => {
    const refs = createAgentReferences();
    const presented = [{ ...mail }, { ...avatar }];
    refs.rememberPresented("v", presented);
    presented.reverse();
    presented[0]!.identity = "mutated";
    refs.focus("v", memory);
    expect(ids(refs.resolve("v", [...agents].reverse(), { target }))).toEqual([mail.identity, avatar.identity]);
    expect(ids(refs.resolve("v", [mail, memory], { target }))).toBe("missing");
    expect(ids(refs.resolve("v", agents, { target, cardinality: "one" }))).toBe("ambiguous");
    expect(ids(refs.resolve("v", agents, { cardinality: "many" }))).toEqual([mail.identity, avatar.identity]);
  });

  it("renouvelle le groupe uniquement par une nouvelle présentation", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", agents);
    refs.rememberPresented("v", [memory]);
    expect(ids(refs.resolve("v", agents, { target: "eux" }))).toEqual([memory.identity]);
    expect(ids(refs.resolve("v", agents, { target: "eux", cardinality: "one" }))).toBe("cardinality");
    refs.rememberPresented("v", []);
    expect(ids(refs.resolve("v", agents))).toBe("notfound");
  });

  it("borne le TTL, les sessions et permet de vider une conversation", () => {
    let now = 100;
    const refs = createAgentReferences({ now: () => now, ttlMs: 10, maxSessions: 2 });
    refs.rememberPresented("v", [mail]);
    now = 110;
    expect(ids(refs.resolve("v", agents))).toBe("expired");
    expect(ids(refs.resolve("v", agents))).toBe("expired");
    refs.focus("chat", avatar);
    refs.focus("third", memory);
    expect(ids(refs.resolve("v", agents))).toBe("no_context");
    refs.clear("chat");
    expect(ids(refs.resolve("chat", agents))).toBe("no_context");
    expect(ids(refs.resolve("third", agents))).toEqual([memory.identity]);
    refs.clear();
    expect(ids(refs.resolve("third", agents))).toBe("no_context");
  });

  it("n'allonge pas le TTL lors d'un échec et autorise une nouvelle sélection explicite", () => {
    let now = 0;
    const refs = createAgentReferences({ now: () => now, ttlMs: 10 });
    refs.rememberPresented("v", agents);
    now = 5;
    refs.resolve("v", agents);
    now = 10;
    expect(ids(refs.resolve("v", agents))).toBe("expired");
    expect(ids(refs.resolve("v", agents, { target: "Luna" }))).toEqual([avatar.identity]);
    expect(ids(refs.resolve("v", agents))).toEqual([avatar.identity]);
  });

  it("émet seulement des diagnostics structurés bornés, sans texte de demande", () => {
    let now = 10;
    const events: ReferenceDiagnostic[] = [];
    const refs = createAgentReferences({ now: () => now, ttlMs: 10, diagnostic: (e) => events.push(e) });
    refs.rememberPresented("v", agents);
    now = 12;
    refs.resolve("v", agents, { target: "second" });
    expect(events.at(-1)).toEqual({ mode: "ordinal", selectedIds: [avatar.identity], matchCount: 1, contextAgeMs: 2 });
    refs.resolve("v", agents, { target: "Floppy" });
    expect(events.at(-1)).toMatchObject({ mode: "name", reason: "ambiguous", selectedIds: [], matchCount: 3 });
    now = 22;
    refs.resolve("v", agents, { target: "him" });
    expect(events.at(-1)).toMatchObject({ reason: "expired", contextAgeMs: 10 });
    refs.resolve("v", agents, { target: "private prompt secret" });
    expect(JSON.stringify(events)).not.toMatch(/private|prompt|secret|Floppy|Filtrage/);
    expect(Object.keys(events[0]!).sort()).toEqual(["contextAgeMs", "matchCount", "mode", "selectedIds"]);
  });

  it("borne les métadonnées et résiste à un diagnostic qui échoue", () => {
    expect(() => createAgentReferences({ maxSessions: 0 })).toThrow(RangeError);
    const refs = createAgentReferences({ maxReferences: 1, diagnostic: () => { throw new Error("journal"); } });
    expect(() => refs.rememberPresented("v", agents)).toThrow(RangeError);
    expect(() => refs.focus("v", { ...mail, identity: "x".repeat(257) })).toThrow(RangeError);
    expect(ids(refs.resolve("v", [mail], { target: "courrier" }))).toEqual([mail.identity]);
  });

  it("borne les candidats sans masquer leur nombre réel dans le diagnostic", () => {
    const events: ReferenceDiagnostic[] = [];
    const refs = createAgentReferences({ maxReferences: 1, diagnostic: (event) => events.push(event) });
    const result = refs.resolve("v", agents, { target: "Floppy" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.candidates).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ reason: "ambiguous", matchCount: 3, selectedIds: [] });
    expect(ids(refs.resolve("v", agents, { target: "Floppy", cardinality: "many" }))).toBe("cardinality");
    refs.rememberPresented("v", [mail]);
    refs.resolve("v", [avatar]);
    expect(events.at(-1)).toMatchObject({ reason: "missing", matchCount: 1 });
  });

  it("conserve les objets adaptés courants et déduplique les identités présentées", () => {
    const refs = createAgentReferences();
    refs.rememberPresented("v", [mail, mail]);
    const adapted = { ...mail, record: { status: "done", pane: "opaque-pane" } };
    const result = refs.resolve("v", [adapted]);
    expect(result.ok && result.references[0]!.record.status).toBe("done");
    expect(result.ok && result.references[0]).toBe(adapted);
  });

  it("borne l'âge diagnostiqué même si l'horloge recule ou avance fortement", () => {
    let now = 10;
    const refs = createAgentReferences({ now: () => now });
    refs.rememberPresented("v", [mail]);
    now = 0;
    expect(refs.resolve("v", agents).contextAgeMs).toBe(0);
    now = Number.MAX_VALUE;
    const result = refs.resolve("v", agents);
    expect(result.contextAgeMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(ids(result)).toBe("expired");
  });
});
