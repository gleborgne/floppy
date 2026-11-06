import { createRequire } from "node:module";

export interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
export interface SherpaSpotter {
  createStream(): SherpaStream; isReady(stream: SherpaStream): boolean; decode(stream: SherpaStream): void;
  reset(stream: SherpaStream): void; getResult(stream: SherpaStream): { keyword: string };
}
const require = createRequire(import.meta.url);
/** Chargement paresseux du SDK natif, uniquement quand ce fournisseur est choisi. */
export function createSpotter(config: unknown): SherpaSpotter {
  const { KeywordSpotter } = require("sherpa-onnx-node") as { KeywordSpotter: new (config: unknown) => SherpaSpotter };
  return new KeywordSpotter(config);
}
