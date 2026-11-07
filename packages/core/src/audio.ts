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

/** PCM 16 bits mono -> fichier WAV complet. */
export function pcmWav(rate: number, pcm: Int16Array): Uint8Array {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, 44 + i * 2);
  return new Uint8Array(b);
}

const WAV_DATA = "data:audio/wav;base64,";

/** Un son pour la fenêtre des réglages (OpResult.audio, champ « audio ») : le WAV en adresse data:. */
export function wavDataUrl(bytes: Uint8Array): string {
  return WAV_DATA + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Valeur d'un champ « audio » -> octets du WAV. undefined : la valeur n'est pas un nouvel enregistrement (ex. le chemin
 * du fichier déjà gardé). Lève une erreur si l'adresse est trop grosse ou ne contient pas un WAV lisible.
 */
export function wavFromDataUrl(value: unknown, maxBytes = 16 * 1024 * 1024): Uint8Array | undefined {
  if (typeof value !== "string" || !value.startsWith(WAV_DATA)) return undefined;
  if ((value.length - WAV_DATA.length) * 0.75 > maxBytes) throw new TextError(T("Enregistrement trop long.", "Recording too long."));
  const bytes = new Uint8Array(Buffer.from(value.slice(WAV_DATA.length), "base64"));
  try { if (!wavPcm(bytes).pcm.length) throw new Error("vide"); }
  catch { throw new TextError(T("L'enregistrement est illisible : recommence.", "The recording cannot be read: try again.")); }
  return bytes;
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
