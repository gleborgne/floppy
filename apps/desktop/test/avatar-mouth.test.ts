import { afterEach, it, expect, vi } from "vitest";
import { createPlayback } from "../src/renderer/app-playback.ts";

afterEach(() => { vi.unstubAllGlobals(); });

/** Le vrai lecteur de voix (app-playback.ts), avec un son simulé (temporel + spectre). */
function player() {
  let tick!: () => void;
  const sound = { wave: (b: Float32Array) => { b.fill(0); }, spectrum: (b: Float32Array) => { b.fill(-Infinity); } };
  const clock = { currentTime: 0, sampleRate: 48000, resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}), destination: {},
    createAnalyser: () => ({ connect() {}, getFloatTimeDomainData: (b: Float32Array) => sound.wave(b), getFloatFrequencyData: (b: Float32Array) => sound.spectrum(b) }),
    createGain: () => ({ connect() {}, gain: { setTargetAtTime() {} } }),
    createBuffer: (_c: number, n: number, rate: number) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {} }),
  };
  vi.stubGlobal("AudioContext", function () { return clock; });
  vi.stubGlobal("setInterval", (fn: () => void) => { tick = fn; return 0; });
  const face = { setLevel: vi.fn(), setMouth: vi.fn(), setSpeechTime: vi.fn(), setSpeechGesture: vi.fn() };
  const life = { kernelEmotion: vi.fn(), resetKernelEmotion: vi.fn() };
  const playback = createPlayback({ face, life, link: { send() {} } });
  const ctx = { audio: playback.playChunk, stop: playback.stop, duck: playback.duck };
  const chunk = new ArrayBuffer(204); new DataView(chunk).setUint32(0, 100, true);
  const hiss = () => { sound.wave = (b) => { b.fill(0.2); }; sound.spectrum = (b) => { b.fill(-60); }; };
  return { clock, face, ctx, chunk, sound, hiss, tick: () => tick() };
}

it("la bouche reçoit la forme du son pendant la lecture, setLevel gardant son rôle", () => {
  const p = player();
  p.hiss();
  p.ctx.audio(p.chunk);
  for (let i = 0; i < 6; i++) p.tick();
  expect(p.face.setMouth).toHaveBeenCalledTimes(6);
  expect(p.face.setMouth.mock.lastCall![1]).toBeGreaterThan(0.5);   // bruit large : étirée
  expect(p.face.setLevel).toHaveBeenLastCalledWith(1);
});

it("la forme est remise à zéro à la pause, à la coupure et en fin de lecture", () => {
  const p = player();
  p.hiss(); p.ctx.audio(p.chunk); p.tick(); p.tick();
  p.ctx.duck(true);
  expect(p.face.setMouth).toHaveBeenLastCalledWith(0, 0);
  p.ctx.duck(false);
  p.tick(); p.tick();
  expect(p.face.setMouth.mock.lastCall![1]).toBeGreaterThan(0);
  p.ctx.stop();
  expect(p.face.setMouth).toHaveBeenLastCalledWith(0, 0);
  p.ctx.audio(p.chunk); p.tick();
  p.clock.currentTime = 5; p.tick();                                 // la file est finie
  expect(p.face.setMouth).toHaveBeenLastCalledWith(0, 0);
});
