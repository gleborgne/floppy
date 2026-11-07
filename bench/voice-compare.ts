// Comparaison locale reproductible. Aucun changement du compte ni de la voix en service dans Floppy.
// node bench/voice-compare.ts --model <CustomVoice-1.7B.gguf> --exe <audiocpp_server> [--voice ono_anna]
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { Kernel, definePlugin, pcmWav, writeFileAtomic, writeJsonAtomic } from "@floppy/core";
import type { SpeechDelivery, TtsService } from "@floppy/contracts";
import audiocpp, { clean } from "../plugins/tts/audiocpp/src/index.ts";

export const SCENES = [
  { intent: "explain", text: "Un arc-en-ciel apparaît quand le soleil éclaire les gouttes de pluie. Chaque goutte sépare la lumière en plusieurs couleurs." },
  { intent: "reassure", text: "Pas de souci. On peut prendre le temps et avancer ensemble, une étape à la fois." },
  { intent: "playful", text: "J'ai retrouvé tes notes. Elles jouaient à cache-cache, mais j'ai gagné." },
] satisfies { intent: SpeechDelivery["intent"]; text: string }[];

export function comparisonModel(values: { model?: string; family?: string; voice?: string; reference?: string; transcript?: string; seed?: string }) {
  const family = values.family ?? "qwen3_tts";
  if (!values.model || !["qwen3_tts", "fish_audio"].includes(family)) throw new Error("Indiquer --model et --family qwen3_tts ou fish_audio.");
  if (family === "qwen3_tts" && !/1[._-]7b.*customvoice/i.test(values.model)) throw new Error("Qwen : utiliser CustomVoice 1.7B.");
  if (family === "fish_audio" && (!values.reference || !values.transcript || !/fish[-_]audio[-_]s2[-_]pro[-_]/i.test(values.model))) throw new Error("Fish S2 : indiquer --reference (WAV) et --transcript (fichier texte).");
  const seed = Number(values.seed ?? "42");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("La graine doit être un entier positif ou nul.");
  const refText = values.transcript ? readFileSync(resolve(values.transcript), "utf8").trim() : "";
  if (family === "fish_audio" && !refText) throw new Error("La transcription Fish est vide.");
  return clean({ label: "Essai expressivité", model: resolve(values.model), famille: family, langue: "fr", seed,
    voix: family === "fish_audio" ? "clone" : "integree", speaker: values.voice ?? "ono_anna",
    refWav: values.reference ? resolve(values.reference) : "", refText });
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function comparisonPage(model: string): string {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Floppy — essai vocal / voice comparison</title>
<style>body{background:#0b0f15;color:#eef8fa;font:16px system-ui;max-width:960px;margin:40px auto;padding:20px}article{background:#111821;border-radius:14px;padding:20px;margin:18px 0}.pair{display:flex;gap:24px;flex-wrap:wrap}h1{color:#46e3ea}audio{display:block;margin-top:10px;max-width:100%}</style>
<h1>Floppy — comparaison vocale / voice comparison</h1><p>${escape(model)}</p><p>Même texte, même voix et graine 42 par défaut. / Same text, voice and default seed 42.</p>
${SCENES.map(s => `<article><p>${escape(s.text)}</p><div class="pair">${[false, true].map(on => `<label>${on ? "Expressif / Expressive" : "Témoin / Baseline"}<audio controls preload="none" src="${s.intent}-${on ? "joueur" : "temoin"}.wav"></audio></label>`).join("")}</div></article>`).join("")}</html>`;
}

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
  const { values } = parseArgs({ options: { model: { type: "string" }, exe: { type: "string" }, voice: { type: "string", default: "ono_anna" }, family: { type: "string" }, reference: { type: "string" }, transcript: { type: "string" }, seed: { type: "string", default: "42" }, output: { type: "string", default: "bench/out/voice-compare" }, backend: { type: "string", default: "auto" }, port: { type: "string", default: "8099" } } });
  if (!values.exe) throw new Error("Indiquer --exe.");
  const model = comparisonModel(values);
  const output = resolve(values.output); mkdirSync(output, { recursive: true });
  let voice: TtsService | undefined;
  const consumer = definePlugin({ manifest: { id: "voice-bench", version: "0", licence: "MIT", slots: [{ id: "bench.voice", service: "tts", section: "voix", label: "Voix" }] },
    async apply(c) { voice = await c.slot<TtsService>("bench.voice"); } });
  const k = new Kernel({ home: join(output, "runtime"), logger: () => {}, plugins: [audiocpp, consumer] });
  const results: object[] = [];
  try {
    await k.applyConfig({ assistant: { language: "fr" }, slots: { "bench.voice": "tts-bench/voice" }, plugins: [
      { id: "tts-bench", plugin: "tts-audiocpp", config: { exe: resolve(values.exe), port: Number(values.port), backend: values.backend, models: {
        voice: model,
      } } }, { id: "bench", plugin: "voice-bench" },
    ] });
    if (!voice) throw new Error(`Voix indisponible : ${JSON.stringify(k.status().map(s => ({ id: s.id, state: s.state, error: s.error })))}`);
    writeFileAtomic(join(output, "index.html"), comparisonPage(model.model));
    for (const scene of SCENES) for (const expressive of [false, true]) {
      const file = `${scene.intent}-${expressive ? "joueur" : "temoin"}.wav`;
      const { wav, ...metrics } = await sample(voice, scene.text, expressive ? { intent: scene.intent, profile: "playful", language: "fr" } : undefined);
      writeFileAtomic(join(output, file), wav);
      results.push({ file, text: scene.text, expressive, ...metrics });
      writeJsonAtomic(join(output, "results.json"), { model: values.model, voice: model.voix === "clone" ? "reference" : model.speaker, seed: model.seed, results });
      console.log(JSON.stringify({ file, ...metrics }));
    }
  } finally { await k.stopAll(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
