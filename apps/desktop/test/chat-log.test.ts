// Journal de la fenêtre « Conversation » : événements relayés relus champ par champ, puis réduits en entrées (sans Electron).
import { describe, it, expect } from "vitest";
import { CHAT_MAX, cleanChatEvent, createChatLog, isLongReply } from "../src/chat-log.ts";
import type { ChatEvent } from "../src/chat-log.ts";

const fresh = () => { let t = 1000; return createChatLog({ render: (md) => `<p>${md}</p>`, now: () => (t += 10) }); };
const run = (log: ReturnType<typeof fresh>, ...events: ChatEvent[]) => events.map((e) => log.apply(e));

describe("cleanChatEvent", () => {
  it("ne garde que les types connus, et une transcription seulement si elle est finale", () => {
    expect(cleanChatEvent(null)).toBeNull();
    expect(cleanChatEvent({ type: "state", state: "idle" })).toBeNull();
    expect(cleanChatEvent({ type: "transcript", text: "salut", final: false })).toBeNull();
    expect(cleanChatEvent({ type: "transcript", text: "salut", final: true, extra: 1 })).toEqual({ type: "transcript", text: "salut" });
    expect(cleanChatEvent({ type: "transcript", text: "  ", final: true })).toBeNull();
    expect(cleanChatEvent({ type: "reply.delta", text: "" })).toBeNull();
    expect(cleanChatEvent({ type: "reply.done", text: 3 })).toEqual({ type: "reply.done", text: "" });
    expect(cleanChatEvent({ type: "notify", text: "ok", important: "oui" })).toEqual({ type: "notify", text: "ok", important: false });
    expect(cleanChatEvent({ type: "card", title: "T", lines: ["a", 2, "b"] })).toEqual({ type: "card", title: "T", text: "a\nb" });
  });
  it("accord et choix : identifiants, options et délais bornés", () => {
    expect(cleanChatEvent({ type: "approval.request", id: "", summary: "x", ttl_s: 5 })).toBeNull();
    expect(cleanChatEvent({ type: "approval.request", id: "a", summary: "x".repeat(5000), ttl_s: 99999 })).toMatchObject({ summary: "x".repeat(2000), ttl_s: 3600 });
    expect(cleanChatEvent({ type: "approval.request", id: "a", summary: "x", ttl_s: "vite" })).toMatchObject({ ttl_s: 60 });
    expect(cleanChatEvent({ type: "choice.request", id: "c", title: "Quel ?", ttl_s: 30, options: [] })).toBeNull();
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `o${i}`, label: `L${i}`, detail: i === 0 ? "d" : undefined }));
    const c = cleanChatEvent({ type: "choice.request", id: "c", title: "Quel ?", ttl_s: 30, options: [...many, { id: "o0", label: "doublon" }, null, { label: "sans id" }] });
    expect(c).toMatchObject({ type: "choice.request", id: "c" });
    expect((c as { options: unknown[] }).options).toHaveLength(50);
    expect((c as { options: unknown[] }).options[0]).toEqual({ id: "o0", label: "L0", detail: "d" });
    expect((c as { options: unknown[] }).options[1]).toEqual({ id: "o1", label: "L1" });
    expect(cleanChatEvent({ type: "choice.closed", id: "c" })).toEqual({ type: "choice.closed", id: "c", picked: "" });
    expect(cleanChatEvent({ type: "choice.closed", id: "c", picked: "o2" })).toMatchObject({ picked: "o2" });
  });
  it("longue réponse : plus de 600 caractères ou de 12 lignes", () => {
    expect(isLongReply("a".repeat(600))).toBe(false);
    expect(isLongReply("a".repeat(601))).toBe(true);
    expect(isLongReply(Array(12).fill("x").join("\n"))).toBe(false);
    expect(isLongReply(Array(13).fill("x").join("\n"))).toBe(true);
  });
});

describe("createChatLog", () => {
  it("une réponse se complète au fil des morceaux, puis se rend en HTML à la fin", () => {
    const log = fresh();
    const [you, d1, d2, done] = run(log, { type: "transcript", text: "Bonjour" }, { type: "reply.delta", text: "Sal" }, { type: "reply.delta", text: "ut **toi**" }, { type: "reply.done", text: "Salut **toi**" });
    expect(you!.changed).toMatchObject([{ kind: "you", text: "Bonjour" }]);
    expect(d1!.changed[0]).toMatchObject({ kind: "reply", text: "Sal", html: "", done: false });
    expect(d2!.changed[0]).toMatchObject({ text: "Salut **toi**", done: false });
    expect(done!.changed[0]).toMatchObject({ done: true, html: "<p>Salut **toi**</p>" });
    expect(log.entries()).toHaveLength(2);
    expect(d1!.changed[0]!.id).toBe(done!.changed[0]!.id);
  });
  it("reply.done sans morceaux crée la réponse ; vide, il n'en reste rien", () => {
    const log = fresh();
    const [a, b] = run(log, { type: "reply.done", text: "Tout d'un coup" }, { type: "reply.done", text: "  " });
    expect(a!.changed[0]).toMatchObject({ kind: "reply", done: true });
    expect(b).toEqual({ changed: [], removed: [] });
    const [, empty] = run(log, { type: "reply.delta", text: "  " }, { type: "reply.done", text: "" });
    expect(empty).toEqual({ changed: [], removed: [2] });
    expect(log.entries()).toHaveLength(1);
  });
  it("un nouveau tour termine la réponse restée ouverte", () => {
    const log = fresh();
    run(log, { type: "reply.delta", text: "coupée" });
    const [next] = run(log, { type: "transcript", text: "Autre chose" });
    expect(next!.changed).toMatchObject([{ kind: "reply", done: true, html: "<p>coupée</p>" }, { kind: "you" }]);
  });
  it("infos, cartes et erreurs deviennent des entrées compactes", () => {
    const log = fresh();
    run(log, { type: "notify", text: "Fini", important: true }, { type: "card", title: "Météo", text: "Beau" }, { type: "error", text: "Boum" });
    expect(log.entries()).toMatchObject([
      { kind: "info", title: "", text: "Fini", important: true }, { kind: "info", title: "Météo", text: "Beau", important: false }, { kind: "error", text: "Boum" },
    ]);
  });
  it("un accord garde son résultat à la fermeture, une seule fois", () => {
    const log = fresh();
    const [req] = run(log, { type: "approval.request", id: "a1", summary: "Envoyer ?", ttl_s: 30 });
    expect(req!.changed[0]).toMatchObject({ kind: "approval", key: "a1", outcome: "pending", at: 1010 });
    expect(log.apply({ type: "approval.request", id: "a1", summary: "Envoyer ?", ttl_s: 30 }).changed).toEqual([]);
    expect(log.apply({ type: "approval.closed", id: "a1", ok: true }).changed[0]).toMatchObject({ outcome: "yes" });
    expect(log.apply({ type: "approval.closed", id: "a1", ok: false }).changed).toEqual([]);
    run(log, { type: "approval.request", id: "a2", summary: "Supprimer ?", ttl_s: 30 });
    expect(log.apply({ type: "approval.closed", id: "a2", ok: false }).changed[0]).toMatchObject({ outcome: "no" });
  });
  it("un choix garde l'option retenue, ou aucune", () => {
    const log = fresh();
    const options = [{ id: "x", label: "X" }, { id: "y", label: "Y", detail: "d" }];
    run(log, { type: "choice.request", id: "c1", title: "Lequel ?", options, ttl_s: 20 });
    expect(log.apply({ type: "choice.closed", id: "c1", picked: "y" }).changed[0]).toMatchObject({ closed: true, picked: "y" });
    run(log, { type: "choice.request", id: "c2", title: "Et ?", options, ttl_s: 20 });
    expect(log.apply({ type: "choice.closed", id: "c2", picked: "" }).changed[0]).toMatchObject({ closed: true, picked: "" });
  });
  it("nouvelle connexion : les demandes en attente sont closes", () => {
    const log = fresh();
    run(log, { type: "approval.request", id: "a", summary: "?", ttl_s: 5 }, { type: "choice.request", id: "c", title: "?", options: [{ id: "x", label: "X" }], ttl_s: 5 });
    const { changed } = log.apply({ type: "session.reset" });
    expect(changed).toMatchObject([{ kind: "approval", outcome: "no" }, { kind: "choice", closed: true, picked: "" }]);
    expect(log.apply({ type: "session.reset" }).changed).toEqual([]);
  });
  it("garde au plus 200 entrées : les plus anciennes partent et sont annoncées", () => {
    const log = fresh();
    let removed: number[] = [];
    for (let i = 0; i < CHAT_MAX + 5; i++) removed = removed.concat(log.apply({ type: "transcript", text: `m${i}` }).removed);
    expect(log.entries()).toHaveLength(CHAT_MAX);
    expect(removed).toEqual([1, 2, 3, 4, 5]);
    expect(log.entries()[0]).toMatchObject({ text: "m5" });
  });
});
