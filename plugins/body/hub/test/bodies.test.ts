// Corps branchés dans la fenêtre des réglages : liste, désactivation (gardée par nom), corps désactivé ignoré.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import type { BodyToKernel, BodyTransport, KernelToBody } from "@floppy/protocol";
import bodyHub, { type BodyHub, type HubEvent } from "../src/index.ts";

function fakeBody() {
  const sent: KernelToBody[] = [];
  let onMsg: (m: BodyToKernel) => void = () => {};
  let onAudio: (f: Float32Array) => void = () => {};
  let onClose: () => void = () => {};
  const transport: BodyTransport = {
    send: (m) => { sent.push(m); },
    sendAudio: () => {},
    onMessage: (fn) => { onMsg = fn; },
    onAudio: (fn) => { onAudio = fn; },
    onClose: (fn) => { onClose = fn; },
    close: () => {},
  };
  return { transport, sent, say: (m: BodyToKernel) => onMsg(m), audio: (f: Float32Array) => onAudio(f), close: () => onClose() };
}
const hello = (id: string, name: string, caps: ("voice" | "approval")[] = ["voice", "approval"]): BodyToKernel => ({ type: "hello", id, name, version: "1", capabilities: caps });

describe("corps branchés (fournisseur bodies)", () => {
  let k: Kernel;
  let hub: BodyHub;
  const oldHome = process.env.FLOPPY_HOME;
  const home = mkdtempSync(join(tmpdir(), "hub-"));
  const boot = async () => {
    process.env.FLOPPY_HOME = home;
    k = new Kernel({ logger: () => {}, home, plugins: [bodyHub] });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 }, plugins: [{ id: "body", plugin: "body-hub" }] });
    hub = k.service<BodyHub>("body")!;
  };
  beforeEach(boot);
  afterEach(async () => {
    await k.stopAll();
    if (oldHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = oldHome;
  });
  const list = async () => (await k.items.snapshot()).find((p) => p.id === "bodies")!;

  it("document.open : transmis comme évènement ; id trop long refusé", () => {
    const b = fakeBody();
    const seen: unknown[] = [];
    hub.on((ev) => { if (ev.type === "message") seen.push(ev.msg); });
    hub.attach(b.transport, { id: "avatar" });
    b.say({ type: "hello", id: "avatar", name: "Avatar", version: "1", capabilities: ["document"] });
    b.say({ type: "document.open", id: "2026-11-06-0905-un" });
    b.say({ type: "document.open", id: "x".repeat(500) });
    expect(seen).toEqual([{ type: "document.open", id: "2026-11-06-0905-un" }]);
  });

  it("déclare le fournisseur bodies (rubrique corps) et liste les sessions avec leurs capacités", async () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "tel" });
    b.say(hello("tel", "Téléphone"));
    const p = await list();
    expect(p.section).toBe("body");
    expect(p.label).toEqual({ fr: "Corps", en: "Bodies" });
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ id: "tel", enabled: true, status: "ok", tags: [{ fr: "voix", en: "voice" }, { fr: "accord", en: "approval" }] });
  });

  it("une demande d'accord dit de quel corps elle vient (un corps distant ne montre que les siennes)", async () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "tel" });
    b.say(hello("tel", "Téléphone"));
    const p = k.approvals.check({ tool: "x", args: {}, level: "write", summary: "test", origin: "tel" });
    await new Promise((r2) => setTimeout(r2, 20));
    expect(b.sent.find((m) => m.type === "approval.request")).toMatchObject({ origin: "tel", summary: "test" });
    k.approvals.respond(k.approvals.pending()[0]!.id, false, "test");
    await p;
  });

  it("un corps désactivé est ignoré : pas de messages, pas d'audio, pas d'accord, rien envoyé", async () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "tel" });
    b.say(hello("tel", "Téléphone"));
    const events: HubEvent[] = [];
    hub.on((e) => events.push(e));
    const r = await k.items.run({ op: "enable", provider: "bodies", id: "tel", on: false }, "ui");
    expect(r.ok).toBe(true);
    expect((await list()).items[0]).toMatchObject({ enabled: false });
    b.say({ type: "text", text: "salut" });
    b.audio(new Float32Array(4));
    expect(events).toEqual([]);
    b.sent.length = 0;
    hub.send("tel", { type: "state", state: "idle" });
    hub.broadcast({ type: "state", state: "idle" });
    expect(b.sent).toEqual([]);
    // accords : jamais envoyés à un corps désactivé
    void k.approvals.check({ tool: "x", args: {}, level: "write", summary: "test" });
    await new Promise((r2) => setTimeout(r2, 20));
    expect(b.sent.filter((m) => m.type === "approval.request")).toEqual([]);
    // réactivé : de nouveau écouté
    await k.items.run({ op: "enable", provider: "bodies", id: "tel", on: true }, "ui");
    b.say({ type: "text", text: "salut" });
    expect(events.some((e) => e.type === "message")).toBe(true);
  });

  it("le choix est gardé par id (fixé par le transport) : un corps désactivé reste listé hors ligne et le reste après un redémarrage", async () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "tel" });
    b.say(hello("tel", "Téléphone"));
    await k.items.run({ op: "enable", provider: "bodies", id: "tel", on: false }, "ui");
    b.close();
    let it = (await list()).items;
    expect(it).toHaveLength(1);
    expect(it[0]).toMatchObject({ label: "tel", enabled: false });
    await k.stopAll();
    await boot();
    const b2 = fakeBody();
    hub.attach(b2.transport, { id: "tel" });
    b2.say(hello("autre-id", "Téléphone"));
    it = (await list()).items;
    expect(it).toHaveLength(1);
    expect(it[0]).toMatchObject({ id: "tel", enabled: false });
  });
  it("identité fixée par le transport : le hello ne choisit ni id ni managed", async () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "dev-1", name: "Mon tel" });
    b.say({ type: "hello", id: "avatar", name: "Pirate", version: "1", capabilities: ["approval"], managed: true });
    expect(hub.sessions()).toMatchObject([{ id: "dev-1", name: "Mon tel" }]);
    expect((await list()).items.map((i) => i.id)).toContain("dev-1"); // pas masqué malgré managed:true
    // sans id de confiance : id aléatoire, jamais celui du client
    const c = fakeBody();
    hub.attach(c.transport);
    c.say({ type: "hello", id: "avatar", name: "Pirate", version: "1", capabilities: [] });
    expect(hub.sessions().map((s) => s.id)).not.toContain("avatar");
    // un corps managed par le transport n'est pas listé
    const m = fakeBody();
    hub.attach(m.transport, { id: "reachy-1", managed: true });
    m.say(hello("x", "Reachy"));
    expect((await list()).items.map((i) => i.id)).not.toContain("reachy-1");
  });

  it("outils corps : un autre corps ne peut pas résoudre l'appel ; id aléatoire ; échec immédiat à la déconnexion", async () => {
    const tool = { name: "ouvre", description: "d", inputSchema: {}, level: "read" as const };
    const a = fakeBody(); const evil = fakeBody();
    hub.attach(a.transport, { id: "a" });
    a.say({ ...hello("a", "A", ["voice"]), tools: [tool] } as BodyToKernel);
    hub.attach(evil.transport, { id: "evil" });
    evil.say(hello("evil", "Evil"));
    const p = k.tools.call("ouvre", {}, { caller: "test" });
    await new Promise((r) => setTimeout(r, 10));
    const call = a.sent.find((m) => m.type === "tool.call") as Extract<KernelToBody, { type: "tool.call" }>;
    expect(call.callId).toMatch(/^[0-9a-f-]{36}$/);
    evil.say({ type: "tool.result", callId: call.callId, ok: true, text: "pwned" });
    a.close(); // débranché : l'appel échoue tout de suite (délai de 20 s sinon)
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.text).not.toContain("pwned");
  });

  it("le corps destinataire résout bien son appel", async () => {
    const tool = { name: "ouvre2", description: "d", inputSchema: {}, level: "read" as const };
    const a = fakeBody();
    hub.attach(a.transport, { id: "a" });
    a.say({ ...hello("a", "A", ["voice"]), tools: [tool] } as BodyToKernel);
    const p = k.tools.call("ouvre2", {}, { caller: "test" });
    await new Promise((r) => setTimeout(r, 10));
    const call = a.sent.find((m) => m.type === "tool.call") as Extract<KernelToBody, { type: "tool.call" }>;
    a.say({ type: "tool.result", callId: call.callId, ok: true, text: "ok" });
    expect(await p).toMatchObject({ status: "done", text: "ok" });
  });

  it("messages invalides : pas d'exception, réponse error", () => {
    const b = fakeBody();
    hub.attach(b.transport, { id: "x" });
    expect(() => b.say(null as unknown as BodyToKernel)).not.toThrow();
    expect(() => b.say({ type: "hello", id: "x", name: "n", version: "1" } as unknown as BodyToKernel)).not.toThrow(); // sans capabilities
    expect(() => b.say({ type: "hello", id: "x", name: "n", version: "1", capabilities: [], tools: [{}] } as unknown as BodyToKernel)).not.toThrow();
    expect(b.sent.filter((m) => m.type === "error")).toHaveLength(3);
    expect(hub.sessions()).toEqual([]);
    b.say(hello("x", "Ok"));
    expect(() => b.say({ type: "approval.response" } as unknown as BodyToKernel)).not.toThrow();
    expect(b.sent.filter((m) => m.type === "error")).toHaveLength(4);
    expect(hub.sessions()).toHaveLength(1);
  });
});
