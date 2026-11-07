// Sons entre le noyau et la fenêtre des réglages : WAV <-> adresse data:audio/wav.
import { describe, it, expect } from "vitest";
import { pcmWav, wavDataUrl, wavFromDataUrl, wavPcm } from "../src/audio.ts";

const wav = (samples: number[], rate = 24000) => pcmWav(rate, Int16Array.from(samples));

describe("wavDataUrl / wavFromDataUrl", () => {
  it("aller-retour : les mêmes échantillons", () => {
    const url = wavDataUrl(wav([1, -2, 300], 16000));
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
    const back = wavPcm(wavFromDataUrl(url)!);
    expect(back.rate).toBe(16000);
    expect([...back.pcm]).toEqual([1, -2, 300]);
  });

  it("une valeur qui n'est pas un nouvel enregistrement (chemin du fichier gardé) : undefined", () => {
    expect(wavFromDataUrl("C:/voix/ref.wav")).toBeUndefined();
    expect(wavFromDataUrl(undefined)).toBeUndefined();
    expect(wavFromDataUrl("data:image/png;base64,AAAA")).toBeUndefined();
  });

  it("refuse un WAV illisible ou trop gros, en deux langues", () => {
    expect(() => wavFromDataUrl("data:audio/wav;base64," + Buffer.from("pas un wav").toString("base64"))).toThrow(/illisible/);
    expect(() => wavFromDataUrl(wavDataUrl(wav(new Array(2000).fill(0))), 1000)).toThrow(/trop long/);
  });
});
