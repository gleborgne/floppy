// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { asPort, fakePort, mountApp } from "./app-harness.ts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("le vrai lecteur synchronise les expressions puis les efface à la coupure", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const clock = { currentTime: 0, resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}), destination: {},
    sampleRate: 48000,
    createAnalyser: () => ({ connect() {}, getFloatTimeDomainData(buf: Float32Array) { buf.fill(0); }, getFloatFrequencyData(buf: Float32Array) { buf.fill(-Infinity); } }),
    createGain: () => ({ connect() {}, gain: { setTargetAtTime() {} } }),
    createBuffer: (_channels: number, n: number, rate: number) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => ({ connect() {}, start(at: number) { starts.push(at); }, stop() {} }),
  };
  vi.stubGlobal("AudioContext", function () { return clock; });
  const { app, avatar, input } = await mountApp();
  const tick = () => vi.advanceTimersByTime(33); // un tour du lecteur
  const audio = (b: ArrayBuffer) => app.playback.playChunk(b);
  const chunk = new ArrayBuffer(204); new DataView(chunk).setUint32(0, 100, true);
  input({ type: "emotion", emotion: "happy", nextAudio: "t1-1" });
  input({ type: "speech.gesture", intent: "explain", intensity: 0.8, nextAudio: "t1-1" }); audio(chunk);
  input({ type: "emotion", emotion: "mischief", nextAudio: "t1-2" });
  input({ type: "speech.gesture", intent: "playful", intensity: 1, nextAudio: "t1-2" }); audio(chunk);
  expect(starts).toEqual([0.04, 1.04]); expect(avatar.setEmotion).not.toHaveBeenCalled();
  expect(avatar.setSpeechGesture).not.toHaveBeenCalled();
  clock.currentTime = 0.04; tick(); expect(avatar.setEmotion).toHaveBeenLastCalledWith("happy", undefined, undefined);
  expect(avatar.setSpeechGesture).toHaveBeenLastCalledWith("explain", 0.8, 0.04);
  clock.currentTime = 1; tick(); expect(avatar.setEmotion).toHaveBeenCalledTimes(1);
  input({ type: "duck", on: true });
  expect(clock.suspend).toHaveBeenCalledOnce(); // silence avant la fin de la phrase utilisateur et le STT
  expect(avatar.setLevel).toHaveBeenLastCalledWith(0);
  expect(avatar.setMouth).toHaveBeenLastCalledWith(0, 0);
  clock.currentTime = 1.1; tick(); // aucun mouvement ni expression pendant la suspension
  expect(avatar.setEmotion).toHaveBeenCalledTimes(1);
  expect(avatar.setSpeechTime).toHaveBeenLastCalledWith(1);
  audio(chunk); expect(clock.resume).toHaveBeenCalledTimes(1);
  clock.currentTime = 1;
  input({ type: "duck", on: false });
  expect(clock.resume).toHaveBeenCalledTimes(2); // ouverture puis reprise après un faux positif
  input({ type: "interrupt" }); expect(avatar.setEmotion).toHaveBeenLastCalledWith("neutral", undefined, undefined);
  expect(avatar.setSpeechGesture).toHaveBeenLastCalledWith(null, undefined, undefined);
  clock.currentTime = 3; tick(); expect(avatar.setEmotion).toHaveBeenCalledTimes(2);
  expect(avatar.setSpeechGesture.mock.calls.some(args => args[0] === "playful")).toBe(false);
  const oldPort = fakePort();
  app.protocol.connect(asPort(oldPort));
  input({ type: "emotion", emotion: "angry", nextAudio: "t2-1" }); audio(chunk);
  app.protocol.connect(asPort(fakePort()));
  expect(oldPort.close).toHaveBeenCalledOnce(); expect(oldPort.onmessage).toBeNull();
  clock.currentTime = 10; tick(); expect(avatar.setEmotion).toHaveBeenCalledTimes(3);
  expect(avatar.setEmotion).toHaveBeenLastCalledWith("neutral", undefined, undefined);
});
