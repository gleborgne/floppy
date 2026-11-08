import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { Kernel, definePlugin } from "@floppy/core";
import { registerDesktop, type AgentTrackingService, type DesktopRegistration } from "@floppy/contracts";
import tracking from "../src/index.ts";
import { createDesktopContributions } from "../../../../apps/desktop/src/desktop-contributions.ts";
import type { BrowserWindow } from "electron";
import { z } from "zod";

function fixture() {
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn((m: unknown) => { manager.message(m as never); }) });
  const windows: any[] = [];
  const logs = vi.fn();
  const manager = createDesktopContributions({ lang: () => "fr", changed() {}, log: logs, packaged: () => true,
    send: m => { parent.emit("message", { data: m }); },
    create: () => {
      const w = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { send: vi.fn() }), close: vi.fn(), setTitle: vi.fn(), loadFile: vi.fn(async () => {}), isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(), restore: vi.fn() }); windows.push(w); return w as unknown as BrowserWindow;
    },
  });
  const unsubscribe = vi.fn(); let publish = () => {};
  const notifications: (() => void)[] = [];
  const providers: AgentTrackingService[] = [];
  const source = definePlugin({ manifest: { id: "source", version: "0", licence: "MIT", provides: ["agentTracking"] }, config: z.object({ revision: z.number().default(0) }), apply(ctx, cfg) {
    const svc: AgentTrackingService = {
      snapshot: vi.fn(() => ({ at: cfg.revision, agents: [], events: [], connection: { state: "connected" as const, coverage: "full" as const } })),
      refresh: vi.fn(async () => {}), subscribe: fn => { publish = fn; notifications.push(fn); return unsubscribe; },
    };
    providers.push(svc); ctx.provide("agentTracking", svc);
  } });
  const second = definePlugin({ manifest: { id: "second", version: "0", licence: "MIT" }, apply(ctx) { registerDesktop(ctx, { id: "own", title: { fr: "Autre", en: "Other" }, menus: ["avatar"], view: { page: "other" } }, { snapshot: () => ({ other: true }), actions: { refresh: () => ({ ok: true }) } }); } });
  const kernel = new Kernel({ host: parent, logger() {}, plugins: [source, tracking, second] });
  kernel.bus.on("plugin.state", s => manager.state(s.id, s.state));
  return { kernel, parent, manager, windows, unsubscribe, providers, notifications, publish: () => publish(), logs };
}
const display = { id: "display", plugin: "display-agent-tracking" };
const source = { id: "source", plugin: "source" };
it("suit le cycle facultatif du noyau sans fournisseur ni vue perimee", async () => {
  const f = fixture();
  try {
    await f.kernel.applyConfig({ plugins: [display] });
    expect(f.kernel.status()[0]?.state).toBe("active");
    expect(f.manager.menu("avatar")).toHaveLength(1);
    f.manager.menu("avatar")[0]!.click(); const offline = f.windows[0];
    expect(f.manager.get({ sender: offline.webContents })?.snapshot).toMatchObject({ agents: [], connection: { state: "offline", coverage: "outage" } });
    expect(await f.manager.action({ sender: offline.webContents }, "refresh")).toEqual({ ok: false });
    await f.kernel.applyConfig({ plugins: [display, source, { id: "second", plugin: "second" }] });
    expect(offline.close).toHaveBeenCalledOnce();
    expect(f.kernel.status().find(s => s.id === "display")?.state).toBe("active");
    expect(f.manager.menu("avatar")).toHaveLength(2);
    f.manager.menu("tray")[0]!.click(); const e = { sender: f.windows[1].webContents };
    expect(f.manager.get(e)?.snapshot).toMatchObject({ connection: { state: "connected" } });
    expect(await f.manager.action(e, "refresh")).toEqual({ ok: true }); expect(f.providers[0]!.refresh).toHaveBeenCalledOnce();
    f.publish(); expect(f.windows[1].show).not.toHaveBeenCalled();
    const firstRegistration = f.parent.postMessage.mock.calls.map(([m]) => m as { type: string; contribution?: DesktopRegistration }).findLast(m => m.type === "desktop.register" && m.contribution?.owner === "display")!.contribution!;
    await f.kernel.applyConfig({ plugins: [display, { ...source, config: { revision: 1 } }, { id: "second", plugin: "second" }] });
    expect(f.providers[0]).not.toBe(f.providers[1]);
    const oldReads = vi.mocked(f.providers[0]!.snapshot).mock.calls.length;
    f.notifications[0]!();
    expect(f.providers[0]!.snapshot).toHaveBeenCalledTimes(oldReads);
    expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.windows[1].close).toHaveBeenCalledOnce();
    expect(await f.manager.action(e, "refresh")).toEqual({ ok: false });
    f.parent.emit("message", { data: { type: "desktop.request", ...firstRegistration, action: "refresh", reqId: 123 } });
    await Promise.resolve(); expect(f.providers[0]!.refresh).toHaveBeenCalledOnce();
    f.manager.menu("tray")[0]!.click();
    expect(await f.manager.action({ sender: f.windows[2].webContents }, "refresh")).toEqual({ ok: true });
    expect(f.providers[0]!.refresh).toHaveBeenCalledOnce();
    expect(f.providers[1]!.refresh).toHaveBeenCalledOnce();
    expect(f.manager.get({ sender: f.windows[2].webContents })?.snapshot).toMatchObject({ at: 1 });
    await f.kernel.applyConfig({ plugins: [{ ...display, disabled: true }, source] });
    expect(f.manager.menu("avatar")).toHaveLength(0); expect(f.unsubscribe).toHaveBeenCalledTimes(2);
    await f.kernel.applyConfig({ plugins: [display, source] }); expect(f.manager.menu("avatar")).toHaveLength(1);
    await f.kernel.applyConfig({ plugins: [display] });
    expect(f.manager.menu("avatar")).toHaveLength(1); expect(f.kernel.status()[0]?.state).toBe("active");
    f.manager.menu("avatar")[0]!.click(); const last = f.windows.at(-1)!;
    expect(f.manager.get({ sender: last.webContents })?.snapshot).toMatchObject({ agents: [], connection: { state: "offline" } });
    expect(await f.manager.action({ sender: last.webContents }, "refresh")).toEqual({ ok: false });
  } finally { await f.kernel.stopAll(); }
  expect(f.parent.listenerCount("message")).toBe(0);
  expect(f.manager.menu("avatar")).toHaveLength(0);
});
