import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { Kernel, definePlugin } from "@floppy/core";
import type { DesktopRegistration } from "@floppy/contracts";
import bodyElectron from "../src/index.ts";
import { createDesktopContributions } from "../../../../apps/desktop/src/desktop-contributions.ts";

it("body-electron apporte Réglages par la même interface et retire son action à l'arrêt", async () => {
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn((_m: unknown) => {}) });
  const manager = createDesktopContributions({ lang: () => "fr", changed() {}, log() {}, send: m => { parent.emit("message", { data: m }); }, create: () => { throw new Error("no generic view needed"); } });
  parent.postMessage.mockImplementation(m => manager.message(m as never));
  const body = definePlugin({ manifest: { id: "body", version: "0", licence: "MIT", provides: ["body"] }, apply(ctx) { ctx.provide("body", { attach() {} } as never); } });
  const k = new Kernel({ host: parent, logger() {}, plugins: [body, bodyElectron] });
  try {
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body" }, { id: "electron", plugin: "body-electron" }] });
    const sent = () => parent.postMessage.mock.calls.map(([m]) => m as { type: string; contribution?: DesktopRegistration; reqId?: string });
    const registration = sent().find(m => m.type === "desktop.register")!.contribution!;
    expect(registration).toMatchObject({ owner: "electron", title: { fr: "Réglages", en: "Settings" }, menus: ["avatar"], actions: ["open"] });
    expect(manager.menu("tray")).toHaveLength(0);
    expect(manager.menu("avatar")).toHaveLength(1); manager.menu("avatar")[0]!.click();
    await vi.waitFor(() => expect(sent().some(m => m.type === "settings.open")).toBe(true));
    const request = sent().find(m => m.type === "settings.open")!;
    parent.emit("message", { data: { type: "settings.open.result", reqId: request.reqId, ok: true } });
    await vi.waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "desktop.result", ok: true })));
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body" }] }); expect(sent()).toContainEqual(expect.objectContaining({ type: "desktop.remove", owner: "electron" }));
  } finally { await k.stopAll(); }
  expect(parent.listenerCount("message")).toBe(0); expect(manager.menu("avatar")).toHaveLength(0);
});
