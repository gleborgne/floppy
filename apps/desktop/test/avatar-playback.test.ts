import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { SpeechExpressions } from "../src/renderer/speech-expressions.ts";

it("le vrai lecteur synchronise les expressions puis les efface à la coupure", () => {
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8"));
  let tick!: () => void;
  const starts: number[] = [];
  const clock = { currentTime: 0, resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}), destination: {},
    createAnalyser: () => ({ connect() {}, getFloatTimeDomainData(buf: Float32Array) { buf.fill(0); } }),
    createGain: () => ({ connect() {}, gain: { setTargetAtTime() {} } }),
    createBuffer: (_channels: number, n: number, rate: number) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => ({ connect() {}, start(at: number) { starts.push(at); }, stop() {} }),
  };
  const face = { setEmotion: vi.fn(), setLevel: vi.fn(), setSpeechTime: vi.fn(), setSpeechGesture: vi.fn() };
  const context = { SpeechExpressions, AudioContext: function () { return clock; },
    setInterval: (fn: () => void) => { tick = fn; }, clearTimeout() {}, performance, face,
    life: { kernel: {}, flashTimer: undefined }, send() {}, port: null, host: null, TOOLS: [] };
  const code = source.slice(source.indexOf("// ------------------------------------------------------------------ voix (lecture)"), source.indexOf("// ------------------------------------------------------------------ micro"))
    + source.slice(source.indexOf("const approvals ="), source.indexOf('window.addEventListener("message"'))
    + "\nglobalThis.input = onMessage; globalThis.audio = playChunk; globalThis.connectPort = connect;";
  const ctx = context as typeof context & { input(m: object): void; audio(b: ArrayBuffer): void; connectPort(p: object): void };
  runInNewContext(code, ctx);
  const chunk = new ArrayBuffer(204); new DataView(chunk).setUint32(0, 100, true);
  ctx.input({ type: "emotion", emotion: "happy", nextAudio: "t1-1" });
  ctx.input({ type: "speech.gesture", intent: "explain", intensity: 0.8, nextAudio: "t1-1" }); ctx.audio(chunk);
  ctx.input({ type: "emotion", emotion: "mischief", nextAudio: "t1-2" });
  ctx.input({ type: "speech.gesture", intent: "playful", intensity: 1, nextAudio: "t1-2" }); ctx.audio(chunk);
  expect(starts).toEqual([0.04, 1.04]); expect(face.setEmotion).not.toHaveBeenCalled();
  expect(face.setSpeechGesture).not.toHaveBeenCalled();
  clock.currentTime = 0.04; tick(); expect(face.setEmotion).toHaveBeenLastCalledWith("happy", undefined, undefined);
  expect(face.setSpeechGesture).toHaveBeenLastCalledWith("explain", 0.8, 0.04);
  clock.currentTime = 1; tick(); expect(face.setEmotion).toHaveBeenCalledTimes(1);
  ctx.input({ type: "duck", on: true });
  expect(clock.suspend).toHaveBeenCalledOnce(); // silence avant la fin de la phrase utilisateur et le STT
  expect(face.setLevel).toHaveBeenLastCalledWith(0);
  clock.currentTime = 1.1; tick(); // aucun mouvement ni expression pendant la suspension
  expect(face.setEmotion).toHaveBeenCalledTimes(1);
  expect(face.setSpeechTime).toHaveBeenLastCalledWith(1);
  ctx.audio(chunk); expect(clock.resume).toHaveBeenCalledTimes(1);
  clock.currentTime = 1;
  ctx.input({ type: "duck", on: false });
  expect(clock.resume).toHaveBeenCalledTimes(2); // ouverture puis reprise après un faux positif
  ctx.input({ type: "interrupt" }); expect(face.setEmotion).toHaveBeenLastCalledWith("neutral");
  expect(face.setSpeechGesture).toHaveBeenLastCalledWith(null);
  clock.currentTime = 3; tick(); expect(face.setEmotion).toHaveBeenCalledTimes(2);
  expect(face.setSpeechGesture.mock.calls.some(args => args[0] === "playful")).toBe(false);
  const oldPort = { onmessage: null, close: vi.fn(), start() {} };
  ctx.connectPort(oldPort);
  ctx.input({ type: "emotion", emotion: "angry", nextAudio: "t2-1" }); ctx.audio(chunk);
  ctx.connectPort({ close() {}, start() {} });
  expect(oldPort.close).toHaveBeenCalledOnce(); expect(oldPort.onmessage).toBeNull();
  clock.currentTime = 10; tick(); expect(face.setEmotion).toHaveBeenCalledTimes(3);
  expect(face.setEmotion).toHaveBeenLastCalledWith("neutral");
});
