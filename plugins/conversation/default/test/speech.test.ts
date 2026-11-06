import { describe, it, expect, vi } from "vitest";
import type { VoiceEvent, VoiceStream, TtsService } from "@floppy/core";
import { SpeechQueue } from "../src/speech.ts";

describe("file TTS distante", () => {
  it("annulation : rejette une réponse réseau tardive et vide les phrases en attente", async () => {
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const heard: VoiceEvent[] = [], requests: string[] = [];
    const tts: TtsService = {
      name: "fake",
      async *speak(text) { requests.push(text); if (text === "ancienne") await wait; yield { rate: 24000, pcm: new Int16Array([1]) }; },
    };
    const stream = { cancel: vi.fn(), speak: vi.fn() } as unknown as VoiceStream;
    const output = new SpeechQueue({ stream, tts, emit: (e) => heard.push(e) });
    output.speak("old", "ancienne"); output.speak("queued", "en attente");
    await vi.waitFor(() => expect(requests).toEqual(["ancienne"]));
    output.cancel(); output.speak("new", "nouvelle"); release();
    await vi.waitFor(() => expect(heard.some((e) => e.type === "speak_done" && e.id === "new")).toBe(true));
    expect(heard.filter((e) => e.type === "audio").map((e) => e.id)).toEqual(["new"]);
    expect(requests).toEqual(["ancienne", "nouvelle"]);
    expect(stream.speak).not.toHaveBeenCalled();
  });
});

describe("voix locale (viaStream)", () => {
  it("la voix locale en service parle dans le flux voix, sans speak()", () => {
    const stream = { cancel: vi.fn(), speak: vi.fn() } as unknown as VoiceStream;
    const output = new SpeechQueue({ stream, tts: { name: "locale", viaStream: true }, emit: () => {} });
    output.speak("a", "Bonjour");
    expect(stream.speak).toHaveBeenCalledWith("a", "Bonjour");
  });
});

describe("écoute seule (flux sans speak)", () => {
  it("voix locale ou aucune voix : la phrase se termine avec une erreur claire", () => {
    const stream = { cancel: vi.fn() } as unknown as VoiceStream;
    const heard: VoiceEvent[] = [];
    new SpeechQueue({ stream, tts: { name: "locale", viaStream: true }, emit: (e) => heard.push(e) }).speak("a", "Bonjour");
    new SpeechQueue({ stream, emit: (e) => heard.push(e), lang: () => "en" }).speak("b", "Hello");
    expect(heard).toEqual([
      { type: "speak_done", id: "a", cancelled: true, error: expect.stringMatching(/Voix locale/) },
      { type: "speak_done", id: "b", cancelled: true, error: expect.stringMatching(/No voice in use/) },
    ]);
  });
});
