// Comparaison locale reproductible. Aucun changement du compte ni de la voix en service dans Floppy.
// node bench/voice-compare.ts --model <CustomVoice-1.7B.gguf> --exe <audiocpp_server> [--voice ono_anna]
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { Kernel, definePlugin, pcmWav, writeFileAtomic, writeJsonAtomic } from "@floppy/core";
import type { SpeechDelivery, TtsService } from "@floppy/contracts";
import audiocpp from "../plugins/tts/audiocpp/src/index.ts";

export const SCENES = [
  { intent: "explain", text: "On va faire simple. D'abord, je classe les notes. Ensuite, on retrouve tout facilement." },
  { intent: "reassure", text: "Pas de souci. On peut prendre le temps et avancer ensemble, une étape à la fois." },
  { intent: "playful", text: "J'ai retrouvé tes notes. Elles jouaient à cache-cache, mais j'ai gagné." },
] satisfies { intent: SpeechDelivery["intent"]; text: string }[];

export async function sample(tts: TtsService, text: string, delivery?: SpeechDelivery) {
  if (!tts.speak) throw new Error("La voix ne permet pas la synthèse directe.");
  const start = performance.now();
  let firstAudioMs: number | undefined, rate = 0, size = 0;
  const chunks: Int16Array[] = [];
  for await (const c of tts.speak(text, { signal: AbortSignal.timeout(120_000), delivery })) {
    if (!c.pcm.length) continue;
    if (rate && rate !== c.rate) throw new Error("Le débit audio a changé pendant la phrase.");
    firstAudioMs ??= Math.round(performance.now() - start);
    rate = c.rate; chunks.push(c.pcm.slice()); size += c.pcm.length;
  }
  if (!size) throw new Error("La voix n'a produit aucun son.");
  const pcm = new Int16Array(size); let at = 0;
  for (const c of chunks) { pcm.set(c, at); at += c.length; }
  return { wav: pcmWav(rate, pcm), firstAudioMs, totalMs: Math.round(performance.now() - start), audioSeconds: size / rate };
}

async function main() {
  const { values } = parseArgs({ options: { model: { type: "string" }, exe: { type: "string" }, voice: { type: "string", default: "ono_anna" }, output: { type: "string", default: "bench/out/voice-compare" }, backend: { type: "string", default: "auto" }, port: { type: "string", default: "8099" } } });
  if (!values.model || !values.exe || !/1[._-]7b.*customvoice/i.test(values.model)) throw new Error("Indiquer --model (CustomVoice 1.7B) et --exe.");
  const output = resolve(values.output); mkdirSync(output, { recursive: true });
  let voice: TtsService | undefined;
  const consumer = definePlugin({ manifest: { id: "voice-bench", version: "0", licence: "MIT", slots: [{ id: "bench.voice", service: "tts", section: "voix", label: "Voix" }] },
    async apply(c) { voice = await c.slot<TtsService>("bench.voice"); } });
  const k = new Kernel({ home: join(output, "runtime"), logger: () => {}, plugins: [audiocpp, consumer] });
  const results: object[] = [];
  try {
    await k.applyConfig({ assistant: { language: "fr" }, slots: { "bench.voice": "tts-bench/voice" }, plugins: [
      { id: "tts-bench", plugin: "tts-audiocpp", config: { exe: resolve(values.exe), port: Number(values.port), backend: values.backend, models: {
        voice: { label: "Essai expressivité", model: resolve(values.model), famille: "qwen3_tts", voix: "integree", speaker: values.voice, langue: "fr" },
      } } }, { id: "bench", plugin: "voice-bench" },
    ] });
    if (!voice) throw new Error(`Voix indisponible : ${JSON.stringify(k.status().map(s => ({ id: s.id, state: s.state, error: s.error })))}`);
    for (const scene of SCENES) for (const expressive of [false, true]) {
      const file = `${scene.intent}-${expressive ? "joueur" : "temoin"}.wav`;
      const { wav, ...metrics } = await sample(voice, scene.text, expressive ? { intent: scene.intent, profile: "playful", language: "fr" } : undefined);
      writeFileAtomic(join(output, file), wav);
      results.push({ file, text: scene.text, expressive, ...metrics });
      writeJsonAtomic(join(output, "results.json"), { model: values.model, voice: values.voice, results });
      console.log(JSON.stringify({ file, ...metrics }));
    }
  } finally { await k.stopAll(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
