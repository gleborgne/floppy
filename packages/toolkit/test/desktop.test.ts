import { expect, it, vi } from "vitest";
import type { DesktopRegistration } from "@floppy/contracts";
import { registerDesktop } from "../src/desktop.ts";
import { Kernel, definePlugin } from "@floppy/core";
import { EventEmitter } from "node:events";

it("retire un abonnement, annule une lecture en cours et ignore les réponses tardives après désinscription", async () => {
  const host = Object.assign(new EventEmitter(), { postMessage: vi.fn((_m: unknown) => {}) });
  let unregister: (() => void) | undefined, publish: (() => void) | undefined, signal: AbortSignal | undefined;
  const unsubscribe = vi.fn();
  const plugin = definePlugin({ manifest: { id: "display", version: "0", licence: "MIT" }, apply(ctx) {
    unregister = registerDesktop(ctx, { id: "own", title: { fr: "Vue", en: "View" }, menus: ["avatar"], view: { page: "own" } }, {
      snapshot: () => ({ safe: true }), subscribe: fn => { publish = fn; return unsubscribe; },
      actions: { refresh: s => { signal = s; return new Promise(() => {}); } },
    });
  } });
  const k = new Kernel({ host, logger() {}, plugins: [plugin] });
  try {
    await k.applyConfig({ plugins: [{ id: "display", plugin: "display" }] });
    const registration = (host.postMessage.mock.calls[0]![0] as { contribution: DesktopRegistration }).contribution;
    host.emit("message", { data: { ...registration, type: "desktop.request", action: "refresh", reqId: 1 } }); await Promise.resolve();
    expect(signal?.aborted).toBe(false); unregister!(); expect(signal?.aborted).toBe(true); expect(unsubscribe).toHaveBeenCalledOnce();
    const count = host.postMessage.mock.calls.length; publish!(); await Promise.resolve(); await Promise.resolve(); expect(host.postMessage.mock.calls).toHaveLength(count);
    unregister!(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(host.listenerCount("message")).toBe(0);
  } finally { await k.stopAll(); }
});

it("borne une lecture qui ignore son signal et ne publie pas le texte de l'erreur", async () => {
  vi.useFakeTimers();
  const host = Object.assign(new EventEmitter(), { postMessage: vi.fn((_m: unknown) => {}) });
  const plugin = definePlugin({ manifest: { id: "display", version: "0", licence: "MIT" }, apply(ctx) {
    registerDesktop(ctx, { id: "own", title: { fr: "Vue", en: "View" }, menus: [], view: { page: "own" } }, { snapshot: () => { throw Error("private prompt"); }, actions: { refresh: () => new Promise(() => {}) } });
  } });
  const k = new Kernel({ host, logger() {}, plugins: [plugin] });
  try {
    await k.applyConfig({ plugins: [{ id: "display", plugin: "display" }] });
    const registration = (host.postMessage.mock.calls[0]![0] as { contribution: DesktopRegistration }).contribution;
    host.emit("message", { data: { ...registration, type: "desktop.request", action: "refresh", reqId: 1 } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(host.postMessage.mock.calls.map(([m]) => m)).toContainEqual(expect.objectContaining({ type: "desktop.result", reqId: 1, ok: false }));
    expect(JSON.stringify(host.postMessage.mock.calls)).not.toContain("private prompt");
  } finally { await k.stopAll(); vi.useRealTimers(); }
});
