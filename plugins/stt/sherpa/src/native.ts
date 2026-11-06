// Accès à sherpa-onnx-node (bibliothèque native), chargé seulement quand un modèle démarre.
import { createRequire } from "node:module";

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  reset(): void;
}
export interface SherpaRecognizer {
  createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
  decodeAsync(stream: unknown): Promise<{ text: string }>;
}
/** Ce dont le plugin a besoin : remplaçable dans les tests. */
export interface Native {
  vad(config: unknown, bufferSeconds: number): SherpaVad;
  recognizer(config: unknown): Promise<SherpaRecognizer>;
}

const require = createRequire(import.meta.url);
type Sdk = {
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad;
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
};
const sdk = (): Sdk => require("sherpa-onnx-node") as Sdk;

export const realNative: Native = {
  vad: (config, bufferSeconds) => new (sdk().Vad)(config, bufferSeconds),
  recognizer: (config) => sdk().OfflineRecognizer.createAsync(config),
};
