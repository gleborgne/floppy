import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createDesktopContributions } from "../src/desktop-contributions.ts";
import { readFileSync } from "node:fs";
function fixture() {
  let lang = "fr";
  const windows: any[] = [];
  const create = vi.fn(() => {
    const win = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { send: vi.fn() }), setTitle: vi.fn(), loadFile: vi.fn(async () => {}), isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), close: vi.fn() });
    windows.push(win); return win as unknown as BrowserWindow;
  });
  const send = vi.fn(), log = vi.fn();
  const manager = createDesktopContributions({ create, send, log, changed() {}, lang: () => lang, packaged: (page) => ["tracking", "other"].includes(page) });
  const register = (owner = "first", page = "tracking", token = "one", extra = {}) => {
    const identity = { owner, id: "view", token };
    manager.message({ type: "desktop.register", ...identity, contribution: { ...identity, title: { fr: owner, en: `${owner} EN` }, menus: ["tray", "avatar"], view: { page }, actions: ["refresh"], ...extra } });
    return identity;
  };
  return { manager, register, create, send, log, windows, english: () => { lang = "en"; manager.language(); } };
}
it("conserve les primitives locales traduites après retrait et déconnexion du backend", () => {
  let lang = "fr";
  const open = vi.fn();
  const manager = createDesktopContributions({ create: () => { throw Error("no view"); }, lang: () => lang, send() {}, changed() {}, log() {},
    local: [{ id: "recovery", title: { fr: "Récupérer", en: "Recover" }, menus: ["tray"], order: 10, open }],
  });
  expect(manager.menu("avatar")).toEqual([]);
  expect(manager.menu("tray").map(e => e.label)).toEqual(["Récupérer"]);
  manager.state("recovery", "error"); manager.reconcile([]); manager.clear();
  lang = "en"; manager.language();
  expect(manager.menu("tray").map(e => e.label)).toEqual(["Recover"]);
  manager.menu("tray")[0]!.click(); expect(open).toHaveBeenCalledOnce();
});
it("deux plugins déclarent des menus ordonnés et des vues traduites, retirables sans changement de l'hôte", () => {
  const f = fixture(); const a = f.register("first", "tracking", "one", { order: 20 }); f.register("second", "other", "two", { order: 10 });
  expect(f.manager.menu("avatar").map(x => x.label)).toEqual(["second", "first"]); expect(f.create).not.toHaveBeenCalled();
  const item = f.manager.menu("tray")[1]!; item.click(); const win = f.windows[0];
  expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/tracking.html$/));
  win.emit("ready-to-show"); win.webContents.emit("did-finish-load");
  f.manager.message({ type: "desktop.update", ...a, snapshot: { count: 1 } }); f.english();
  expect(win.show).toHaveBeenCalledOnce(); expect(win.focus).not.toHaveBeenCalled(); expect(win.setTitle).toHaveBeenLastCalledWith("first EN");
  expect(f.manager.get({ sender: win.webContents })).toEqual({ lang: "en", snapshot: { count: 1 } });
  item.click(); expect(win.focus).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce();
  f.manager.message({ type: "desktop.remove", ...a }); expect(win.close).toHaveBeenCalledOnce(); expect(f.manager.get({ sender: win.webContents })).toBeNull();
  item.click(); expect(f.create).toHaveBeenCalledOnce(); expect(f.manager.menu("avatar")).toHaveLength(1); f.manager.clear(); expect(f.manager.menu("avatar")).toHaveLength(0);
});
it("isole les expéditeurs, réponses, actions et générations ; ferme les demandes en cours au retrait", async () => {
  const f = fixture(); const a = f.register(), b = f.register("second", "other", "two");
  f.manager.menu("avatar")[0]!.click(); f.manager.menu("avatar")[1]!.click(); const event = { sender: f.windows[0].webContents };
  expect(f.manager.get(event, "extra")).toBeNull();
  expect(await f.manager.action({ sender: {} }, "refresh")).toEqual({ ok: false });
  expect(await f.manager.action(event, "send")).toEqual({ ok: false }); expect(await f.manager.action(event, "refresh", {})).toEqual({ ok: false });
  const response = f.manager.action(event, "refresh"); const request = f.send.mock.lastCall![0]; expect(request.owner).toBe("first");
  let settled = false; void response.then(() => { settled = true; });
  f.manager.message({ type: "desktop.result", ...b, reqId: request.reqId, ok: true, value: "foreign" }); await Promise.resolve(); expect(settled).toBe(false);
  f.manager.message({ type: "desktop.result", ...a, reqId: request.reqId, ok: true, value: { ok: true } }); expect(await response).toEqual({ ok: true });
  const pending = f.manager.action(event, "refresh"); f.manager.state("first", "stopping"); expect(await pending).toEqual({ ok: false });
  f.register("first", "tracking", "new"); f.manager.message({ type: "desktop.remove", ...a }); expect(f.manager.menu("avatar")).toHaveLength(2);
  expect(await f.manager.action(event, "refresh")).toEqual({ ok: false });
  f.manager.message({ type: "desktop.update", ...a, snapshot: "old" }); f.manager.menu("avatar")[0]!.click(); expect(f.manager.get({ sender: f.windows[2].webContents })?.snapshot).toBeUndefined(); f.manager.clear();
});
it.each(["../tracking", "https://contoso.test", "file:///private", "C:/models/private", "%2e%2e", "tracking.html", "missing", "tracking/other", "..\\tracking"])("refuse toute page non empaquetée ou chemin : %s", page => {
  const f = fixture(); f.register("first", page); expect(f.manager.menu("avatar")).toHaveLength(0); expect(f.log).toHaveBeenCalledWith("first/view", "registration.invalid");
});
it("refuse les preloads injectés et doubles inscriptions ; conserve le propriétaire original", () => {
  const f = fixture(); f.register("first", "tracking", "one", { view: { page: "tracking", preload: "evil.cjs" } }); expect(f.manager.menu("avatar")).toHaveLength(0);
  const a = f.register(); f.manager.menu("avatar")[0]!.click(); f.register("first", "other", "other"); expect(f.windows[0].close).not.toHaveBeenCalled();
  f.manager.message({ type: "desktop.remove", ...a }); expect(f.windows[0].close).toHaveBeenCalledOnce();
});
it("borne les attentes et traces d'échec, révoque les inscriptions d'un démarrage échoué", async () => {
  vi.useFakeTimers(); try {
    const f = fixture(); const a = f.register(); f.manager.menu("avatar")[0]!.click(); const pending = f.manager.action({ sender: f.windows[0].webContents }, "refresh"); await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ ok: false }); expect(f.log).toHaveBeenCalledWith("first/view", "request.timeout");
    f.manager.message({ type: "desktop.failure", ...a, reason: "secret business contents" }); expect(JSON.stringify(f.log.mock.calls)).not.toContain("secret");
    f.manager.reconcile([]); expect(f.windows[0].close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it("main et kernel n'importent ni ne câblent le suivi", () => {
  for (const file of ["main.ts", "kernel.ts"]) expect(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).not.toMatch(/tracking|Tracking|agentTracking|createTrackingWindow|watchTracking/);
});

it("attribue les échecs de création et de chargement sans conserver de vue invalide", async () => {
  const f = fixture(); f.register(); f.create.mockImplementationOnce(() => { throw Error("secret path"); }); f.manager.menu("avatar")[0]!.click();
  expect(f.log).toHaveBeenCalledWith("first/view", "view.open-failed");
  f.manager.menu("avatar")[0]!.click(); const win = f.windows[0]; win.emit("closed");
  expect(f.manager.get({ sender: win.webContents })).toBeNull();
  f.create.mockImplementationOnce(() => { win.loadFile.mockRejectedValueOnce(new Error("private content")); return win; });
  f.manager.menu("avatar")[0]!.click(); await Promise.resolve(); await Promise.resolve();
  expect(f.log).toHaveBeenCalledWith("first/view", "view.load-failed"); expect(win.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/secret path|private content/);
  f.manager.clear();
});
