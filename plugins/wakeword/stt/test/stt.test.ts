import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type WakewordService, type WakewordDetection } from "@floppy/core";
import stt from "../src/index.ts";

async function fixture(legacy?: string, voiceEnabled = true) {
  const home = mkdtempSync(join(tmpdir(), "wake-stt-"));
  if (legacy) writeFileSync(join(home, "settings.json"), JSON.stringify({ mot_activation: legacy }));
  const openVoice = vi.fn(async () => { throw new Error("Aucun deuxième flux STT ne doit être ouvert"); });
  const voice = definePlugin({ manifest: { id: "existing-voice", version: "0", licence: "MIT", provides: ["voice"] }, apply(c) { c.provide("voice", { name: "STT existant", open: openVoice }); } });
  // Consommateur du slot listen.wakeword (comme la conversation).
  const held: { svc?: WakewordService } = {};
  const probe = definePlugin({
    manifest: { id: "wake-probe", version: "0", licence: "MIT", slots: [{ id: "listen.wakeword", service: "wakeword", section: "ecoute", label: "Mot d'activation", none: "Aucun" }] },
    async apply(ctx) { held.svc = await ctx.slot<WakewordService>("listen.wakeword"); },
  });
  const k = new Kernel({ home, logger: () => {}, plugins: [stt, voice, probe] });
  await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy", "flopy"] }, slots: { "listen.wakeword": "stt/account" }, plugins: [
    ...(voiceEnabled ? [{ id: "voice", plugin: "existing-voice" }] : []), { id: "stt", plugin: "wakeword-stt" }, { id: "probe", plugin: "wake-probe" },
  ] });
  return { k, openVoice, service: held.svc!, update: (words: string[]) => k.items.run({ op: "update", provider: "stt-account", id: "account", values: { words } }, "ui") };
}

describe("plugin wakeword STT", () => {
  it("réutilise les transcriptions, respecte les mots complets et garde les indices audio", async () => {
    const f = await fixture();
    try {
      const detected: WakewordDetection[] = [];
      const stream = await f.service.open({ body: "a", signal: new AbortController().signal, onDetection: d => detected.push(d), onError() {} });
      stream.pushAudio(new Float32Array(512), 0);
      stream.pushTranscript!({ text: "Une disquette floppyDisk" });
      expect(detected).toHaveLength(0);
      stream.pushTranscript!({ text: "Hé FLÓPY, quelle heure ?", startSample: 1200, endSample: 5600 });
      expect(detected).toEqual([{ word: "flopy", startSample: 1200, endSample: 5600 }]);
      expect(f.openVoice).not.toHaveBeenCalled();
      stream.close(); stream.pushTranscript!({ text: "Floppy" });
      expect(detected).toHaveLength(1);
    } finally { await f.k.stopAll(); }
  });
  it("migre les anciennes variantes et les remplace par la configuration du plugin", async () => {
    const f = await fixture("jarvis, salut robot");
    try {
      expect(f.service.words!()).toEqual(["jarvis", "salut robot"]);
      const changed = vi.fn(), off = f.service.onChange(changed);
      expect((await f.update(["Marvin"])).ok).toBe(true);
      expect(changed).toHaveBeenCalledOnce(); off();
      expect(f.service.words!()).toEqual(["Marvin"]);
      expect((await f.update(["a", "b"])).ok).toBe(false);
      expect(f.service.words!()).toEqual(["Marvin"]);
    } finally { await f.k.stopAll(); }
  });
  it("montre le dernier réveil dans les réglages, et un nom par défaut dans les deux langues", async () => {
    const f = await fixture();
    try {
      const item = async () => (await f.k.items.snapshot()).find((p) => p.id === "stt-account")!.items[0]!;
      expect((await item()).detail).toBeUndefined();
      expect((await item()).label).toEqual({ fr: "Mots d'activation", en: "Wake words" });
      expect(f.service.name).toBe("Dans le texte transcrit");
      const stream = await f.service.open({ body: "a", signal: new AbortController().signal, onDetection() {}, onError() {} });
      stream.pushTranscript!({ text: "Rien à voir" });
      expect((await item()).detail).toBeUndefined();
      stream.pushTranscript!({ text: "  Flopy,   quelle heure ? " });
      expect((await item()).detail).toEqual({ fr: expect.stringMatching(/^Dernier réveil : « Flopy, quelle heure \? » à \d\d:\d\d$/), en: expect.stringMatching(/^Last wake: “Flopy, quelle heure \?” at \d\d:\d\d$/) });
      // Le nom choisi par l'utilisateur remplace le nom par défaut.
      expect((await f.k.items.run({ op: "update", provider: "stt-account", id: "account", values: { name: "Maison" } }, "ui")).ok).toBe(true);
      expect(f.service.name).toBe("Maison");
      stream.close();
    } finally { await f.k.stopAll(); }
  });
  it("signale le STT absent au lieu de charger un autre moteur", async () => {
    const f = await fixture(undefined, false);
    try {
      // Pas de service voix : le détecteur ne peut pas être mis en service, et la raison est visible sur le slot.
      expect(f.service).toBeUndefined();
      expect(f.k.slots().find((x) => x.id === "listen.wakeword")).toMatchObject({ state: "error", error: expect.stringContaining("service voix actif") });
      expect(f.openVoice).not.toHaveBeenCalled();
    } finally { await f.k.stopAll(); }
  });
});
