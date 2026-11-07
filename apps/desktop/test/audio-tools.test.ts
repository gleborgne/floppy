import { describe, it, expect } from "vitest";
import { wavPcm, wavFromDataUrl } from "@floppy/core";
// @ts-expect-error module .js sans types
import { analyze, encodeWav, RATE, trimSilence, waveBars, wavDataUrl } from "../src/renderer/audio-tools.js";

/** Une « voix » : un son de 200 Hz, entre deux silences. */
function voice(silence: number, speech: number, amp = 0.5, noise = 0): Float32Array {
  const n = Math.round((silence * 2 + speech) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const inSpeech = t >= silence && t < silence + speech;
    out[i] = (inSpeech ? amp * Math.sin(2 * Math.PI * 200 * t) : 0) + (noise ? noise * Math.sin(i * 12.9898) : 0);
  }
  return out;
}

describe("audio-tools : l'enregistrement d'une voix", () => {
  it("WAV : le noyau relit les mêmes échantillons, en adresse data: aussi", () => {
    const bytes = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1.2]), 16000);
    const back = wavPcm(bytes);
    expect(back.rate).toBe(16000);
    expect([...back.pcm]).toEqual([0, 16384, -16383, 32767, -32767]);
    expect([...wavPcm(wavFromDataUrl(wavDataUrl(bytes))!).pcm]).toEqual([...back.pcm]);
  });

  it("coupe le silence aux bords, avec 0,2 s de marge", () => {
    const cut = trimSilence(voice(2, 3));
    expect(cut.length / RATE).toBeGreaterThan(3.3);
    expect(cut.length / RATE).toBeLessThan(3.5);
    expect(trimSilence(new Float32Array(RATE)).length).toBe(0); // rien que du silence
  });

  it("qualité : durée, saturation, trop faible, bruit de fond", () => {
    const ok = analyze(voice(0.5, 12));
    expect(ok).toMatchObject({ clipped: false, tooQuiet: false, noisy: false });
    expect(ok.seconds).toBeCloseTo(13, 1);
    expect(analyze(voice(0.5, 3, 1.5)).clipped).toBe(true);
    expect(analyze(voice(0.5, 3, 0.05)).tooQuiet).toBe(true);
    expect(analyze(voice(0.5, 3, 0.3, 0.2)).noisy).toBe(true);
  });

  it("forme d'onde : n barres entre 0 et 1", () => {
    const bars = waveBars(voice(1, 2), 40);
    expect(bars).toHaveLength(40);
    expect(Math.max(...bars)).toBe(1);
    expect(bars[0]).toBe(0);
  });
});
