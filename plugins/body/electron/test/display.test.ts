// Réglages d'affichage : déclarés par le plugin, envoyés au processus principal à chaque changement.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Kernel } from "@floppy/core";
import type { BodyHub } from "@floppy/contracts";
import type { BodyToKernel, KernelToBody } from "@floppy/protocol";
import conversation from "@floppy/plugin-conversation";
import { EventEmitter } from "node:events";
import bodyHub from "@floppy/plugin-body-hub";
import bodyElectron from "../src/index.ts";

// Faux canal de l'app de bureau, donné au noyau (option host) : plus aucun objet global du processus.
const proc: { parentPort?: unknown } = {};

describe("réglages d'affichage", () => {
  afterEach(() => { delete proc.parentPort; });

  it.each(["Ouvre-moi la fenêtre de tes réglages, s'il te plaît.", "Tu peux m'ouvrir les réglages, s'il te plaît ?", "Floppy, ouvre les paramètres"])("commande directe sans modèle : %s", async (text) => {
    const parent = new EventEmitter() as EventEmitter & { postMessage(m: unknown): void };
    let request: { type: string; reqId: string } | undefined;
    parent.postMessage = m => { const r = m as typeof request; if (r?.type === "settings.open") request = r; };
    proc.parentPort=parent;
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins:[bodyHub,bodyElectron,conversation] });
    try {
      await k.applyConfig({ assistant:{name:'Floppy',wake_words:['floppy']}, plugins:[{id:'body',plugin:'body-hub'},{id:'bodyel',plugin:'body-electron'},{id:'conv',plugin:'conversation'}] });
      let receive!: (m: BodyToKernel) => void;
      const sent: KernelToBody[]=[];
      k.service<BodyHub>('body')!.attach({send:m=>sent.push(m),sendAudio(){},onAudio(){},onClose(){},close(){},onMessage:fn=>{receive=fn;}},{id:'probe'});
      receive({type:'hello',id:'probe',name:'probe',version:'0',capabilities:['text']});
      receive({type:'text',text});
      await vi.waitFor(()=>expect(request).toBeDefined());
      expect(sent.some(m=>m.type==='reply.done')).toBe(false);
      parent.emit('message',{data:{type:'settings.open.result',reqId:request!.reqId,ok:true}});
      await vi.waitFor(()=>expect(sent.find(m=>m.type==='reply.done')).toMatchObject({text:'La fenêtre des réglages est affichée.'}));
    } finally { await k.stopAll(); }
  });

  it.each(["Open the settings.", "Can you open Floppy's settings please?", "show me the preferences"])("en anglais, commande directe sans modèle : %s", async (text) => {
    const parent = new EventEmitter() as EventEmitter & { postMessage(m: unknown): void };
    let request: { type: string; reqId: string } | undefined;
    parent.postMessage = m => { const r = m as typeof request; if (r?.type === "settings.open") request = r; };
    proc.parentPort = parent;
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, bodyElectron, conversation] });
    try {
      await k.applyConfig({ assistant: { name: "Floppy", language: "en", wake_words: ["floppy"] }, plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }, { id: "conv", plugin: "conversation" }] });
      let receive!: (m: BodyToKernel) => void;
      const sent: KernelToBody[] = [];
      k.service<BodyHub>("body")!.attach({ send: m => sent.push(m), sendAudio() {}, onAudio() {}, onClose() {}, close() {}, onMessage: fn => { receive = fn; } }, { id: "probe" });
      receive({ type: "hello", id: "probe", name: "probe", version: "0", capabilities: ["text"] } as BodyToKernel);
      receive({ type: "text", text });
      await vi.waitFor(() => expect(request).toBeDefined());
      parent.emit("message", { data: { type: "settings.open.result", reqId: request!.reqId, ok: true } });
      await vi.waitFor(() => expect(sent.find(m => m.type === "reply.done")).toMatchObject({ text: "The settings window is shown." }));
    } finally { await k.stopAll(); }
  });

  it("ouvrir_reglages attend la confirmation de la fenêtre et transmet son échec", async () => {
    const parent = new EventEmitter() as EventEmitter & { postMessage(m: unknown): void };
    let request: { type: string; reqId: string } | undefined;
    parent.postMessage = (m) => { const r = m as typeof request; if (r?.type === "settings.open") request = r; };
    proc.parentPort = parent;
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }] });
    try {
      expect(k.tools.list().some((t) => t.name === "ouvrir_reglages")).toBe(true);
      const result = k.tools.call("ouvrir_reglages", {});
      await Promise.resolve(); await Promise.resolve();
      expect(request?.type).toBe("settings.open");
      parent.emit("message", { data: { type: "settings.open.result", reqId: request!.reqId, ok: false, text: "Chargement impossible" } });
      expect(await result).toMatchObject({ status: "failed", text: "Chargement impossible" });
      const success = k.tools.call("ouvrir_reglages", {});
      await Promise.resolve(); await Promise.resolve();
      parent.emit("message", { data: { type: "settings.open.result", reqId: request!.reqId, ok: true } });
      expect(await success).toMatchObject({ status: "done" });
    } finally { await k.stopAll(); }
  });

  it("envoie l'état au démarrage puis à chaque changement", async () => {
    const sent: { type: string; settings?: Record<string, unknown> }[] = [];
    proc.parentPort = { on: () => {}, postMessage: (m: never) => { sent.push(m); } };
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] },
      approvals: { timeout_s: 5 },
      plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }],
    });
    const first = sent.find((m) => m.type === "display");
    expect(first?.settings).toMatchObject({ avatar_visible: true, masquer_apres: 0, bulle: true, toujours_devant: true, demarrage_windows: false, avatar: "" });
    const keys = k.settings.list().filter((s) => s.section === "corps").map((s) => s.key);
    expect(keys.sort()).toEqual(["avatar_visible", "bulle", "masquer_apres", "toujours_devant"]);
    expect(k.settings.list().find((s) => s.key === "demarrage_windows")?.section).toBe("systeme");
    const r = await k.settings.change("masquer_apres", 15, "ui");
    expect(r.ok).toBe(true);
    const r2 = await k.settings.change("avatar_visible", false, "ui");
    expect(r2.ok).toBe(true);
    const last = [...sent].reverse().find((m) => m.type === "display");
    expect(last?.settings).toMatchObject({ masquer_apres: 15, avatar_visible: false });
    await k.stopAll();
  });

  it("hors de l'app (pas de parentPort) : inactif sans erreur, registre d'avatars quand même fourni", async () => {
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] },
      approvals: { timeout_s: 5 },
      plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }],
    });
    const st = k.status().find((e) => e.id === "bodyel")!;
    expect(st.state).toBe("active");
    expect(st.error).toBeUndefined();
    expect(k.settings.list().some((s) => s.key === "avatar_visible")).toBe(false);
    expect(k.service("avatars")).toBeDefined();
    await k.stopAll();
  });
});
