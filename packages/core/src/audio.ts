import { T, TextError } from "./i18n.ts";
/** Conversion explicite en little-endian ; aucune hypothèse sur l'alignement des blocs réseau. */
export function floatToPcm16(frame: Float32Array): Buffer {
  const bytes = Buffer.alloc(frame.length * 2);
  for (let i = 0; i < frame.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, frame[i] ?? 0)) * 32767), i * 2);
  return bytes;
}

export class Pcm16Decoder {
  private tail = Buffer.alloc(0);
  push(data: Uint8Array): Int16Array {
    const bytes = Buffer.concat([this.tail, data]);
    const count = Math.floor(bytes.length / 2);
    this.tail = bytes.subarray(count * 2);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) pcm[i] = bytes.readInt16LE(i * 2);
    return pcm;
  }
  finish(): void { if (this.tail.length) throw new TextError(T("Flux PCM tronqué (échantillon incomplet)", "Truncated PCM stream (incomplete sample)")); }
}

/** Tampon micro borné, horloge monotone conservée même quand on efface le contenu. */
export class AudioHistory {
  end = 0;
  private start = 0;
  private readonly data: Float32Array;
  constructor(seconds = 30) { this.data = new Float32Array(seconds * 16000); }
  push(frame: Float32Array): void {
    for (const sample of frame) this.data[this.end++ % this.data.length] = sample;
    this.start = Math.max(this.start, this.end - this.data.length);
  }
  clear(): void { this.start = this.end; this.data.fill(0); }
  /** Premier échantillon encore disponible (notamment après une mise en veille). */
  get begin(): number { return this.start; }
  slice(start: number, end = this.end): Float32Array | undefined {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < this.start || end > this.end || start >= end) return undefined;
    return Float32Array.from({ length: end - start }, (_, i) => this.data[(start + i) % this.data.length]!);
  }
}

/** WAV 16 bits -> PCM mono (on garde le premier canal). Une taille de données trop grande (flux) est bornée au fichier. */
export function wavPcm(bytes: Uint8Array): { rate: number; pcm: Int16Array } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF") throw new Error("le fichier audio n'est pas un WAV");
  let rate = 24000;
  let channels = 1;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") { channels = b.readUInt16LE(p + 10); rate = b.readUInt32LE(p + 12); }
    if (id === "data") {
      const end = Math.min(b.length, p + 8 + size);
      const n = Math.floor((end - (p + 8)) / 2);
      const all = new Int16Array(n);
      for (let i = 0; i < n; i++) all[i] = b.readInt16LE(p + 8 + i * 2);
      if (channels <= 1) return { rate, pcm: all };
      const mono = new Int16Array(Math.floor(n / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels]!;
      return { rate, pcm: mono };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("WAV sans données audio");
}
