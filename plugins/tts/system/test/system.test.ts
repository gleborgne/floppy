// Voix du système : lecteurs de sortie (purs) et, sous Windows, une vraie phrase par WinRT dans le noyau.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import tts, { alias, chunks, itemId, parseEspeakVoices, parseSayVoices, parseWindowsVoices, pickVoices } from "../src/index.ts";

describe("lecture des listes de voix", () => {
  it("Windows : JSON du PowerShell, objet seul ou tableau", () => {
    expect(parseWindowsVoices('[{"id":"MSTTS_V110_frFR_JulieM","name":"Microsoft Julie","lang":"fr-FR","gender":"Female"}]'))
      .toEqual([{ id: "MSTTS_V110_frFR_JulieM", name: "Microsoft Julie", lang: "fr-FR", gender: "Female" }]);
    expect(parseWindowsVoices('{"id":"a","name":"A","lang":"en-US"}')).toEqual([{ id: "a", name: "A", lang: "en-US" }]);
  });

  it("macOS : noms avec espaces et parenthèses", () => {
    const out = "Albert              en_US    # Hello! My name is Albert.\nAmélie (Enhanced)   fr_CA    # Bonjour, je m'appelle Amélie.\nBad News            en_US    # The light you see…\n";
    expect(parseSayVoices(out)).toEqual([
      { id: "Albert", name: "Albert", lang: "en-US" },
      { id: "Amélie (Enhanced)", name: "Amélie (Enhanced)", lang: "fr-CA" },
      { id: "Bad News", name: "Bad News", lang: "en-US" },
    ]);
  });

  it("Linux : tableau espeak-ng, une voix par langue", () => {
    const out = "Pty Language       Age/Gender VoiceName          File                 Other Languages\n 5  fr-fr           --/M      French_(France)    roa/fr\n 5  fr-fr           --/F      French_bis         roa/fr2\n 5  en-gb           --/M      English_(Great_Britain) gmw/en\n";
    expect(parseEspeakVoices(out)).toEqual([
      { id: "fr-fr", name: "French (France)", lang: "fr-fr", gender: "Male" },
      { id: "en-gb", name: "English (Great Britain)", lang: "en-gb", gender: "Male" },
    ]);
  });
});

describe("choix et découpage", () => {
  const v = (name: string, lang: string) => ({ id: name, name, lang });
  it("langue de l'assistant d'abord, puis l'anglais ; le reste caché", () => {
    expect(pickVoices([v("Zira", "en-US"), v("Anna", "de-DE"), v("Paul", "fr-FR"), v("Julie", "fr-FR")], ["fr", "en"]).map((x) => x.name)).toEqual(["Julie", "Paul", "Zira"]);
  });
  it("aucune voix dans ces langues : on montre tout", () => {
    expect(pickVoices([v("Anna", "de-DE")], ["fr"]).map((x) => x.name)).toEqual(["Anna"]);
  });
  it("ids et prénoms", () => {
    expect(itemId("Amélie (Enhanced)")).toBe("Am-lie-Enhanced-");
    expect(alias("Microsoft Julie")).toBe("julie");
    expect(alias("Amélie (Enhanced)")).toBe("amélie");
  });
  it("morceaux de 100 ms", () => {
    const parts = [...chunks(16000, new Int16Array(3500))];
    expect(parts.map((p) => p.pcm.length)).toEqual([1600, 1600, 300]);
  });
});

describe.runIf(process.platform === "win32")("Windows, pour de vrai", () => {
  it("liste les voix, démarre une voix et dit une phrase", async () => {
    let got: TtsService | undefined;
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: "voice.tts", service: "tts", section: "voice", label: "Voix" }] },
      async apply(c) { got = await c.slot<TtsService>("voice.tts"); },
    });
    const home = mkdtempSync(join(tmpdir(), "tts-system-"));
    const k = new Kernel({ logger: () => {}, home, plugins: [tts, consumer] });
    try {
      await k.applyConfig({ plugins: [{ id: "sys", plugin: "tts-system" }, { id: "c", plugin: "consumer" }] });
      expect(got?.name).toMatch(/\((système|system)\)$/);
      const parts = [];
      for await (const c of got!.speak!("Bonjour.", { signal: new AbortController().signal })) parts.push(c);
      expect(parts.length).toBeGreaterThan(2);
      expect(parts[0]!.rate).toBeGreaterThanOrEqual(8000);
      expect(parts.some((p) => p.pcm.some((s) => s !== 0))).toBe(true);
      // Phrase abandonnée : on rend la main sans attendre le système.
      const abort = new AbortController();
      const it = got!.speak!("Une phrase qu'on coupe.", { signal: abort.signal })[Symbol.asyncIterator]();
      const next = it.next();
      abort.abort();
      await expect(next).rejects.toBeDefined();
      // La phrase suivante marche toujours.
      let n = 0;
      for await (const _ of got!.speak!("Encore.", { signal: new AbortController().signal })) n++;
      expect(n).toBeGreaterThan(0);
    } finally { await k.stopAll(); }
  }, 30_000);
});
