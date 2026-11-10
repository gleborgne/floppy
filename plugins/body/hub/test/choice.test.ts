// Choix dans une liste : routage vers les corps `choice`, carte pour le corps d'origine sans `choice`, droit de répondre.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, T } from "@floppy/core";
import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import bodyHub, { type BodyHub } from "../src/index.ts";

function fakeBody() {
  const sent: KernelToBody[] = [];
  let onMsg: (m: BodyToKernel) => void = () => {};
  const transport: BodyTransport = {
    send: (m) => { sent.push(m); },
    sendAudio: () => {},
    onMessage: (fn) => { onMsg = fn; },
    onAudio: () => {},
    onClose: () => {},
    close: () => {},
  };
  return { transport, sent, say: (m: BodyToKernel) => onMsg(m) };
}
const hello = (id: string, caps: Capability[]): BodyToKernel => ({ type: "hello", id, name: id, version: "1", capabilities: caps });
const options = [{ id: "a", label: T("Alpha", "Alpha"), detail: "premier" }, { id: "b", label: "Bravo" }];
const kinds = (b: { sent: KernelToBody[] }, type: string) => b.sent.filter((m) => m.type === type);

describe("hub des corps : choix dans une liste", () => {
  let k: Kernel;
  let hub: BodyHub;
  const oldHome = process.env.FLOPPY_HOME;
  const boot = async (config: unknown = {}) => {
    const home = mkdtempSync(join(tmpdir(), "hub-choice-"));
    process.env.FLOPPY_HOME = home;
    k = new Kernel({ logger: () => {}, home, plugins: [bodyHub] });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, plugins: [{ id: "body", plugin: "body-hub", config }] });
    hub = k.service<BodyHub>("body")!;
  };
  const join_ = (id: string, caps: Capability[]) => { const b = fakeBody(); hub.attach(b.transport, { id }); b.say(hello(id, caps)); return b; };
  afterEach(async () => {
    await k.stopAll();
    if (oldHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = oldHome;
  });

  it("envoie la demande aux corps `choice`, une réponse la ferme et prévient les corps", async () => {
    await boot();
    const a = join_("a", ["choice"]);
    const other = join_("o", ["voice", "approval"]);
    const p = k.choices.ask({ title: "Lequel ?", options });
    const [req] = kinds(a, "choice.request") as Extract<KernelToBody, { type: "choice.request" }>[];
    expect(req).toMatchObject({ title: "Lequel ?", options: [{ id: "a", label: "Alpha", detail: "premier" }, { id: "b", label: "Bravo" }], ttl_s: 60 });
    expect(kinds(other, "choice.request")).toHaveLength(0);
    a.say({ type: "choice.response", id: req!.id, option: "b" });
    expect(await p).toEqual({ picked: "b", reason: "user", by: "a" });
    expect(kinds(a, "choice.closed")).toEqual([{ type: "choice.closed", id: req!.id, picked: "b" }]);
    expect(kinds(other, "choice.closed")).toHaveLength(0);
  });

  it("corps d'origine sans `choice` mais avec `display` : une carte numérotée ; sans display : rien", async () => {
    await boot();
    const screen = join_("screen", ["display", "voice"]);
    const mute = join_("mute", ["voice"]);
    const p = k.choices.ask({ title: "Lequel ?", options, origin: "screen" });
    expect(kinds(screen, "card")).toEqual([{ type: "card", title: "Lequel ?", lines: ["1. Alpha — premier", "2. Bravo"] }]);
    k.choices.cancelAll();
    await p;
    const p2 = k.choices.ask({ title: "Lequel ?", options, origin: "mute" });
    expect(kinds(mute, "card")).toHaveLength(0);
    k.choices.cancelAll();
    await p2;
  });

  it("un corps `choice` d'origine reçoit la demande, pas de carte en plus", async () => {
    await boot();
    const full = join_("full", ["choice", "display"]);
    const p = k.choices.ask({ title: "?", options, origin: "full" });
    expect(kinds(full, "choice.request")).toHaveLength(1);
    expect(kinds(full, "card")).toHaveLength(0);
    k.choices.cancelAll();
    await p;
  });

  it("la réponse n'est acceptée que d'un corps autorisé (capacité `choice`, approvalsFrom)", async () => {
    await boot({ approvalsFrom: ["ok"] });
    const ok = join_("ok", ["choice"]);
    const no = join_("no", ["choice"]);
    const nocap = join_("ok2", ["approval"]);
    const p = k.choices.ask({ title: "?", options });
    const [req] = kinds(ok, "choice.request") as Extract<KernelToBody, { type: "choice.request" }>[];
    expect(kinds(no, "choice.request")).toHaveLength(0);
    no.say({ type: "choice.response", id: req!.id, option: "a" });
    nocap.say({ type: "choice.response", id: req!.id, option: "a" });
    expect(k.choices.pending()).toHaveLength(1);
    ok.say({ type: "choice.response", id: req!.id, option: "zzz" });
    expect(k.choices.pending()).toHaveLength(1);
    ok.say({ type: "choice.response", id: req!.id, option: "a" });
    expect(await p).toMatchObject({ picked: "a", by: "ok" });
  });

  it("un corps désactivé est ignoré : rien reçu, réponse sans effet", async () => {
    await boot();
    const a = join_("a", ["choice"]);
    const b = join_("b", ["choice"]);
    await k.items.run({ op: "enable", provider: "bodies", id: "a", on: false }, "ui");
    const p = k.choices.ask({ title: "?", options });
    expect(kinds(a, "choice.request")).toHaveLength(0);
    const [req] = kinds(b, "choice.request") as Extract<KernelToBody, { type: "choice.request" }>[];
    a.say({ type: "choice.response", id: req!.id, option: "a" });
    expect(k.choices.pending()).toHaveLength(1);
    k.choices.cancelAll();
    await p;
    expect(kinds(a, "choice.closed")).toHaveLength(0);
  });

  it("un corps branché pendant un choix le reçoit, avec le temps restant", async () => {
    await boot();
    const p = k.choices.ask({ title: "Lequel ?", options, ttl_s: 30 });
    const late = join_("late", ["choice"]);
    const [req] = kinds(late, "choice.request") as Extract<KernelToBody, { type: "choice.request" }>[];
    expect(req).toMatchObject({ title: "Lequel ?", ttl_s: 30 });
    const noCap = join_("nocap", ["voice"]);
    expect(kinds(noCap, "choice.request")).toHaveLength(0);
    k.choices.cancelAll();
    await p;
  });

  it("la capacité `choice` a une étiquette lisible dans la liste des corps", async () => {
    await boot();
    join_("a", ["choice"]);
    const items = (await k.items.snapshot()).find((x) => x.id === "bodies")!.items;
    expect(items[0]).toMatchObject({ tags: [{ fr: "choix dans une liste", en: "choice in a list" }] });
  });
});
