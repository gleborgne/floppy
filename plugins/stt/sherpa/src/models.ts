// Reconnaître un modèle sherpa-onnx à ses fichiers, et en tirer la config de la bibliothèque.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Detected =
  | { kind: "vad"; file: string }
  | { kind: "stt"; encoder: string; decoder: string; joiner: string; tokens: string }
  | { kind: "error"; reason: { fr: string; en: string } };

/** Le fichier `<partie>*.onnx` du dossier ; s'il y en a plusieurs, la version int8 (plus légère) d'abord. */
function part(files: string[], name: string): string | undefined {
  const found = files.filter((f) => f.toLowerCase().startsWith(name) && f.toLowerCase().endsWith(".onnx"));
  return found.find((f) => /int8/i.test(f)) ?? found.sort()[0];
}

/**
 * Un fichier .onnx seul : détecteur de parole Silero.
 * Un dossier avec encoder*.onnx, decoder*.onnx, joiner*.onnx et tokens.txt : transcription (transducteur, ex. Parakeet).
 */
export function detect(path: string): Detected {
  let st;
  try { st = statSync(path); } catch {
    return { kind: "error", reason: { fr: `Introuvable : ${path}`, en: `Not found: ${path}` } };
  }
  if (st.isFile()) {
    return /\.onnx$/i.test(path)
      ? { kind: "vad", file: path }
      : { kind: "error", reason: { fr: "Un fichier de modèle doit finir par .onnx.", en: "A model file must end with .onnx." } };
  }
  const files = readdirSync(path);
  const encoder = part(files, "encoder"), decoder = part(files, "decoder"), joiner = part(files, "joiner");
  const tokens = files.find((f) => f.toLowerCase() === "tokens.txt");
  if (encoder && decoder && joiner && tokens) {
    return { kind: "stt", encoder: join(path, encoder), decoder: join(path, decoder), joiner: join(path, joiner), tokens: join(path, tokens) };
  }
  return { kind: "error", reason: {
    fr: "Dossier non reconnu : il faut encoder*.onnx, decoder*.onnx, joiner*.onnx et tokens.txt (ex. Parakeet TDT).",
    en: "Folder not recognized: it needs encoder*.onnx, decoder*.onnx, joiner*.onnx and tokens.txt (e.g. Parakeet TDT).",
  } };
}

export interface VadTuning { threshold: number; minSilenceMs: number }

/** Config du détecteur Silero : trames de 512 échantillons, comme le service Python. */
export function vadConfig(file: string, t: VadTuning): unknown {
  return {
    sileroVad: { model: file, threshold: t.threshold, minSilenceDuration: t.minSilenceMs / 1000, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 30 },
    sampleRate: 16000, numThreads: 1, debug: 0,
  };
}

/** Config de la transcription : le type exact (NeMo, Zipformer…) est lu par la bibliothèque dans le modèle. */
export function recognizerConfig(m: Extract<Detected, { kind: "stt" }>, threads: number): unknown {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner }, tokens: m.tokens, numThreads: threads, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search",
  };
}
