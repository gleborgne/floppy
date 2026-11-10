// Envoi des résultats des tâches sur les canaux « notify » (Telegram, mail…) : réglage « Envoyer à » et outil « envoyer ».
import { describe, it, expect, afterEach } from "vitest";
import { Kernel, definePlugin, type PluginDef, type DocRef } from "@floppy/core";
import type { NotifyMessage } from "@floppy/contracts";
import { createSchedulerPlugin } from "../src/index.ts";

let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

/** Faux plugin de canaux : deux destinations, la 2e peut échouer. */
function channels(sent: { channel: string; msg: NotifyMessage }[], opts: { failMail?: boolean } = {}): PluginDef<any> {
  return definePlugin({
    manifest: { id: "fake-notify", version: "0", licence: "MIT", provides: ["notify"] },
    apply(ctx) {
      ctx.offer("notify", {
        items: () => [{ id: "canal", label: "Mon canal", cloud: true }, { id: "gmail", label: "Gmail perso", cloud: true }],
        start(f, item) {
          f.provide("notify", {
            async send(msg) {
              if (item === "gmail" && opts.failMail) throw new Error("serveur mail injoignable");
              sent.push({ channel: item, msg });
            },
          });
        },
      });
    },
  });
}

function digest(): PluginDef<any> {
  return definePlugin({
    manifest: { id: "digest", version: "0", licence: "MIT", provides: ["task"], tasks: [{ id: "quotidienne", label: "Veille du jour" }] },
    apply(ctx) {
      ctx.provide("task", { run: async () => ({ summary: "Ta veille est prête.", document: { id: "d1", title: "Veille du 6 novembre", date: "", source: "veille", tags: ["veille"] } }) });
    },
  });
}

function docs(): PluginDef<any> {
  const ref: DocRef = { id: "d1", title: "Veille du 6 novembre", date: "", source: "veille", tags: ["veille"] };
  return definePlugin({
    manifest: { id: "docs", version: "0", licence: "MIT", provides: ["documents"] },
    apply(ctx) {
      ctx.provide("documents", {
        save: async () => ref, show: async () => undefined,
        list: async () => [ref],
        get: async (id) => (id === "d1" ? { ...ref, markdown: "# Veille\n\n**1. Un article**" } : undefined),
      });
    },
  });
}

async function setup(sent: { channel: string; msg: NotifyMessage }[], opts: { failMail?: boolean } = {}) {
  const initiatives: { text: string }[] = [];
  k = new Kernel({ logger: () => {}, plugins: [channels(sent, opts), digest(), docs(), createSchedulerPlugin()] });
  k.bus.on("initiative", (p) => { initiatives.push(p); });
  await k.applyConfig({
    plugins: [{ id: "notify", plugin: "fake-notify" }, { id: "veille", plugin: "digest" }, { id: "docs", plugin: "docs" }, { id: "sched", plugin: "scheduler", config: { delaiDemarrageS: 3600 } }],
    approvals: { send: "always" },
  });
  return initiatives;
}

const wait = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 10)); await k!.idle(); } };

describe("envoi des résultats", () => {
  it("le réglage « Envoyer à » fait partir le document sur les canaux choisis après chaque passage", async () => {
    const sent: { channel: string; msg: NotifyMessage }[] = [];
    await setup(sent);
    const key = "taches.veille.quotidienne.envoi";
    const info = k!.settings.list().find((s) => s.key === key)!;
    expect(info.value).toBe("nulle part");
    expect(info.presets?.map((p) => p.value)).toEqual(["Mon canal", "Gmail perso", "Mon canal, Gmail perso", "nulle part"]);

    // Rien de choisi : rien ne part.
    await k!.tasks.run("veille/quotidienne", "manual");
    await wait();
    expect(sent).toEqual([]);

    expect((await k!.settings.change(key, "sur mon canal et gmail", "ui")).ok).toBe(true);
    expect(k!.settings.list().find((s) => s.key === key)!.value).toBe("Mon canal, Gmail perso");
    await k!.tasks.run("veille/quotidienne", "manual");
    await wait();
    expect(sent.map((s) => s.channel)).toEqual(["canal", "gmail"]);
    expect(sent[0]!.msg).toEqual({ title: "Veille du 6 novembre", markdown: "# Veille\n\n**1. Un article**" });
    // Le canal est rendu après l'envoi : plus rien ne tourne.
    expect(k!.status().some((s) => s.fork && s.state === "active")).toBe(false);
  });

  it("un canal inconnu est refusé ; un envoi raté est signalé", async () => {
    const sent: { channel: string; msg: NotifyMessage }[] = [];
    const initiatives = await setup(sent, { failMail: true });
    const key = "taches.veille.quotidienne.envoi";
    const bad = await k!.settings.change(key, "whatsapp", "ui");
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/Je ne connais pas « whatsapp »/);
    await k!.settings.change(key, "Gmail perso", "ui");
    await k!.tasks.run("veille/quotidienne", "manual");
    await wait();
    expect(initiatives.at(-1)?.text).toBe("L'envoi de « Veille du jour » sur Gmail perso a échoué : serveur mail injoignable.");
  });

  it("l'outil « envoyer » envoie le dernier document, ou celui demandé", async () => {
    const sent: { channel: string; msg: NotifyMessage }[] = [];
    await setup(sent);
    const r = await k!.tools.call("envoyer", { canal: "mon canal", quoi: "veille" });
    expect(r.status).toBe("done");
    expect(r.text).toBe("« Veille du 6 novembre » envoyé sur Mon canal.");
    expect(sent.map((s) => s.channel)).toEqual(["canal"]);
    const no = await k!.tools.call("envoyer", { canal: "fax" });
    expect(no.status).toBe("failed");
    expect(no.text).toMatch(/Canaux : « Mon canal », « Gmail perso »/);
  });

  it("en anglais : canaux dits en anglais, échec annoncé en anglais", async () => {
    const sent: { channel: string; msg: NotifyMessage }[] = [];
    const initiatives = await setup(sent, { failMail: true });
    await k!.settings.change("langue_assistant", "en", "ui");
    await k!.idle();
    const key = "taches.veille.quotidienne.envoi";
    expect((await k!.settings.change(key, "to my canal and gmail", "ui")).ok).toBe(true);
    expect((await k!.settings.change(key, "nowhere", "ui")).ok).toBe(true);
    expect(k!.settings.list().find((s) => s.key === key)!.value).toBe("nulle part");
    await k!.settings.change(key, "Gmail perso", "ui");
    await k!.tasks.run("veille/quotidienne", "manual");
    await wait();
    expect(initiatives.at(-1)?.text).toMatch(/^Sending ".*" to Gmail perso failed: /);
    const r = await k!.tools.call("envoyer", { canal: "on my canal", quoi: "latest" });
    expect(r.text).toBe('"Veille du 6 novembre" sent to Mon canal.');
  });
});
