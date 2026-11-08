// Registre de contributions : aucune connaissance du domaine des plugins.
import type { BrowserWindow } from "electron";
import type { DesktopRegistration } from "@floppy/contracts";
import type { SafeWindowOptions } from "./windows.ts";
import { existsSync } from "node:fs";
import { pageFile } from "./ui.ts";

type Message = { type?: string; owner?: string; id?: string; token?: string; reqId?: number; snapshot?: unknown; ok?: boolean; value?: unknown; reason?: string; contribution?: DesktopRegistration };
type Entry = { definition: DesktopRegistration; win?: BrowserWindow; snapshot?: unknown };
export function createDesktopContributions(deps: {
  create(options: SafeWindowOptions): BrowserWindow;
  lang(): string;
  send(message: object): void;
  changed(): void;
  log(id: string, reason: string): void;
  packaged?(page: string): boolean;
  /** Primitives locales déclarées par l'hôte, indépendantes du backend. */
  local?: { id: string; title: { fr: string; en: string }; menus: ("tray" | "avatar")[]; order?: number; open(): void }[];
}) {
  const entries = new Map<string, Entry>();
  const pending = new Map<number, { entry: Entry; finish(value: unknown): void }>();
  let sequence = 0;
  const key = (m: { owner?: string; id?: string }) => `${m.owner}/${m.id}`;
  const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
  const label = (e: Entry) => deps.lang() === "en" ? e.definition.title.en : e.definition.title.fr;
  const payload = (e: Entry) => ({ snapshot: e.snapshot, lang: deps.lang() });
  const push = (e: Entry) => { if (e.win && !e.win.isDestroyed()) { e.win.setTitle(label(e)); e.win.webContents.send("desktop:update", payload(e)); } };
  const request = (e: Entry, action: string, reqId?: number) => deps.send({ type: "desktop.request", owner: e.definition.owner, id: e.definition.id, token: e.definition.token, action, reqId });
  const remove = (e: Entry, reason: string) => {
    entries.delete(key(e.definition));
    for (const p of [...pending.values()]) if (p.entry === e) p.finish({ ok: false });
    const win = e.win; e.win = undefined;
    if (win && !win.isDestroyed()) win.close();
    deps.log(key(e.definition), reason); deps.changed();
  };
  const invoke = (e: Entry, action: string): Promise<unknown> => {
    if (entries.get(key(e.definition)) !== e || !e.definition.actions.includes(action)) { deps.log(key(e.definition), "request.action-not-registered"); return Promise.resolve({ ok: false }); }
    return new Promise((resolve) => {
      const reqId = ++sequence;
      const timer = setTimeout(() => { deps.log(key(e.definition), "request.timeout"); finish({ ok: false }); }, 10_000);
      const finish = (value: unknown) => { clearTimeout(timer); pending.delete(reqId); resolve(value); };
      pending.set(reqId, { entry: e, finish });
      try { request(e, action, reqId); } catch { deps.log(key(e.definition), "request.failed"); finish({ ok: false }); }
    });
  };
  const open = (e: Entry) => {
    if (entries.get(key(e.definition)) !== e) return;
    if (!e.definition.view) { void invoke(e, "open"); return; }
    if (e.win && !e.win.isDestroyed()) { if (e.win.isMinimized()) e.win.restore(); e.win.show(); e.win.focus(); return; }
    try {
      const target = deps.create({ size: { width: 760, height: 700, minWidth: 400, minHeight: 400 }, title: label(e), preload: "preload-desktop.cjs" });
      e.win = target;
      void target.loadFile(pageFile(e.definition.view.page)).catch(() => { if (e.win === target) { deps.log(key(e.definition), "view.load-failed"); target.close(); e.win = undefined; } });
      target.webContents.once("did-finish-load", () => { if (e.win === target) push(e); });
      target.once("ready-to-show", () => { if (e.win === target) target.show(); });
      target.on("closed", () => { if (e.win === target) e.win = undefined; });
      request(e, "$snapshot");
    } catch { deps.log(key(e.definition), "view.open-failed"); if (e.win && !e.win.isDestroyed()) e.win.close(); e.win = undefined; }
  };
  const from = (event: { sender: unknown }) => [...entries.values()].find((e) => e.win && !e.win.isDestroyed() && e.win.webContents === event.sender);
  return {
    message(m: Message) {
      if (m.type === "desktop.register") {
        const d = m.contribution;
        const valid = d && identifier(d.owner) && identifier(d.id) && identifier(d.token)
          && d.owner === m.owner && d.id === m.id && d.token === m.token
          && d.title && typeof d.title.fr === "string" && typeof d.title.en === "string" && d.title.fr.length <= 200 && d.title.en.length <= 200
          && Array.isArray(d.menus) && d.menus.length <= 2 && d.menus.every((v) => v === "tray" || v === "avatar")
          && (d.order === undefined || Number.isFinite(d.order))
          && Array.isArray(d.actions) && d.actions.length <= 20 && d.actions.every(identifier)
          && (!d.view || (Object.keys(d.view).length === 1 && identifier(d.view.page) && (deps.packaged?.(d.view.page) ?? existsSync(pageFile(d.view.page)))))
          && (d.view || d.actions.includes("open"));
        if (!valid) { deps.log(identifier(m.owner) && identifier(m.id) ? key(m) : "invalid", "registration.invalid"); return; }
        const old = entries.get(key(d));
        if (old) { deps.log(key(d), "registration.duplicate"); return; }
        entries.set(key(d), { definition: structuredClone(d) }); deps.log(key(d), "registered"); deps.changed(); return;
      }
      const e = entries.get(key(m));
      if (!e || e.definition.token !== m.token) return;
      if (m.type === "desktop.remove") remove(e, "removed");
      else if (m.type === "desktop.update") { e.snapshot = m.snapshot; push(e); }
      else if (m.type === "desktop.failure") deps.log(key(e.definition), m.reason === "snapshot.failed" ? "snapshot.failed" : "action.failed");
      else if (m.type === "desktop.result" && typeof m.reqId === "number") {
        const p = pending.get(m.reqId);
        if (p?.entry === e) { if (!m.ok) deps.log(key(e.definition), "request.refused"); p.finish(m.ok ? m.value : { ok: false }); }
      }
    },
    menu(location: "tray" | "avatar") {
      const plugin = [...entries.values()].map(e => ({ ...e.definition, key: key(e.definition), click: () => open(e) }));
      const local = (deps.local ?? []).map(e => ({ ...e, key: `host/${e.id}`, click: e.open }));
      return [...local, ...plugin].filter(e => e.menus.includes(location))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key))
        .map(e => ({ label: deps.lang() === "en" ? e.title.en : e.title.fr, click: e.click }));
    },
    get(event: { sender: unknown }, ...args: unknown[]) { const e = from(event); if (!e || args.length) { deps.log(e ? key(e.definition) : "unknown", "snapshot.sender-or-arguments"); return null; } return payload(e); },
    action(event: { sender: unknown }, action: unknown, ...args: unknown[]) { const e = from(event); if (!e || args.length || typeof action !== "string") { deps.log(e ? key(e.definition) : "unknown", "request.sender-or-arguments"); return Promise.resolve({ ok: false }); } return invoke(e, action); },
    language() { for (const e of entries.values()) push(e); deps.changed(); },
    state(owner: string, state: string) { if (state !== "active" && state !== "starting") for (const e of [...entries.values()]) if (e.definition.owner === owner) remove(e, "provider.inactive"); },
    reconcile(owners: string[]) { for (const e of [...entries.values()]) if (!owners.includes(e.definition.owner)) remove(e, "provider.inactive"); },
    clear() { for (const e of [...entries.values()]) remove(e, "backend.disconnected"); },
  };
}
