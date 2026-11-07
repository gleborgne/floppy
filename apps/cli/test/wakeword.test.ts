import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, definePlugin } from "@floppy/core";
import type { WakewordService, WakewordDetection } from "@floppy/contracts";
import sherpa from "@floppy/plugin-wakeword-sherpa";
import porcupine from "@floppy/plugin-wakeword-porcupine";

const mocks = vi.hoisted(() => ({ sherpa: vi.fn(), porcupine: vi.fn(), release: vi.fn(), process: vi.fn(), word: "", fail: false }));
vi.mock("../../../plugins/wakeword/sherpa/src/native.ts", () => ({ createSpotter: (config: unknown) => {
  mocks.sherpa(config);
  return { createStream: () => ({ ready: false, acceptWaveform() { this.ready = true; } }), isReady: (s: { ready: boolean }) => s.ready,
    decode(s: { ready: boolean }) { s.ready = false; }, getResult: () => ({ keyword: mocks.word }), reset() {} };
} }));
vi.mock("@picovoice/porcupine-node", () => ({ Porcupine: class {
  sampleRate = 16000; frameLength = 4;
  constructor(...args: unknown[]) { mocks.porcupine(...args); if (mocks.fail) throw new Error("secret-do-not-print"); }
  process(pcm: Int16Array) { mocks.process(Array.from(pcm)); return mocks.word ? 0 : -1; }
  release() { mocks.release(); }
} }));

afterEach(() => { vi.clearAllMocks(); mocks.word = ""; mocks.fail = false; });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wakeword-"));
  const paths = Object.fromEntries(["encoder", "decoder", "joiner", "tokens", "keywordsFile", "keywordPath", "modelPath"].map(key => {
    const file = join(dir, key); writeFileSync(file, "fixture"); return [key, file];
  }));
  const secrets = new MemorySecrets();
  // Consommateur du slot (comme la conversation) : il garde le détecteur choisi.
  const held: { svc?: WakewordService } = {};
  const probe = definePlugin({
    manifest: { id: "wake-probe", version: "0", licence: "MIT", slots: [{ id: "listen.wakeword", service: "wakeword", section: "ecoute", label: "Mot d'activation", none: "Aucun" }] },
    async apply(ctx) { held.svc = await ctx.slot<WakewordService>("listen.wakeword"); ctx.effect(() => { held.svc = undefined; }); },
  });
  const k = new Kernel({ home: join(dir, "home"), logger: () => {}, secrets, plugins: [sherpa, porcupine, probe] });
  await k.applyConfig({ plugins: [{ id: "s", plugin: "wakeword-sherpa" }, { id: "p", plugin: "wakeword-porcupine" }, { id: "probe", plugin: "wake-probe" }] });
  const configure = (id: string, values: Record<string, unknown>) => k.items.run({ op: "update", provider: `${id}-account`, id: "account", values }, "ui");
  return { k, paths, secrets, configure, wake: () => held.svc };
}

describe("plugins wakeword configurables et sélection exclusive", () => {
  it("expose deux configurations et un sélecteur générique, sans activer de SDK", async () => {
    const f = await fixture();
    try {
      expect(f.wake()).toBeUndefined();
      const selector = f.k.settings.list().find(s => s.key === "slot.listen.wakeword")!;
      expect(selector.options!.map(o => o.value)).toEqual(["@none", "s/account", "p/account"]);
      expect((await f.k.settings.change("slot.listen.wakeword", "s/account", "ui")).ok).toBe(false);
      const providers = await f.k.items.snapshot();
      expect(providers.find(p => p.id === "s-account")!.kinds[0]!.fields.some(field => field.type === "secret")).toBe(false);
      expect(providers.find(p => p.id === "p-account")!.kinds[0]!.fields.some(field => field.type === "secret")).toBe(true);
      expect(mocks.sherpa).not.toHaveBeenCalled(); expect(mocks.porcupine).not.toHaveBeenCalled();
    } finally { await f.k.stopAll(); }
  });
  it("sauvegarde chaque configuration et n'expose que le fournisseur choisi", async () => {
    const f = await fixture();
    try {
      expect((await f.configure("s", f.paths)).ok).toBe(true);
      expect((await f.configure("p", { ...f.paths, apiKey: "secret-do-not-print" })).ok).toBe(true);
      expect((await f.k.settings.change("slot.listen.wakeword", "s/account", "ui")).ok).toBe(true);
      expect(f.wake()!.name).toBe("Sherpa ONNX");
      expect((await f.k.settings.change("slot.listen.wakeword", "p/account", "ui")).ok).toBe(true);
      expect(f.wake()!.name).toBe("Porcupine");
      expect(JSON.stringify(await f.k.items.snapshot())).not.toContain("secret-do-not-print");
      expect(f.secrets.get("wakeword-porcupine/p/apiKey")).toBe("secret-do-not-print");
      await f.k.settings.change("slot.listen.wakeword", "@none", "ui");
      expect(f.wake()).toBeUndefined();
    } finally { await f.k.stopAll(); }
  });
  it("Sherpa : CPU, horloge absolue, notification de configuration et fermeture", async () => {
    const f = await fixture();
    try {
      await f.configure("s", f.paths); await f.k.settings.change("slot.listen.wakeword", "s/account", "ui");
      const service = f.wake()!;
      const detected: WakewordDetection[] = [];
      const abort = new AbortController();
      const stream = await service.open({ body: "a", signal: abort.signal, onDetection: d => detected.push(d), onError: () => {} });
      mocks.word = "FLOPPY";
      stream.pushAudio(new Float32Array(4), 40000);
      expect(detected).toEqual([{ word: "FLOPPY", startSample: 16004, endSample: 40004 }]);
      expect(mocks.sherpa.mock.calls[0]![0]).toMatchObject({ modelConfig: { provider: "cpu", numThreads: 1 } });
      const changed = vi.fn(), off = service.onChange(changed);
      await f.configure("s", { threshold: 0.4 }); expect(changed).toHaveBeenCalledOnce(); off();
      abort.abort(); stream.pushAudio(new Float32Array(4), 80000);
      expect(detected).toHaveLength(1);
    } finally { await f.k.stopAll(); }
  });
  it("Porcupine : trames PCM16 exactes malgré les blocs coupés, libération à l'arrêt", async () => {
    const f = await fixture();
    try {
      await f.configure("p", { ...f.paths, apiKey: "secret-do-not-print" }); await f.k.settings.change("slot.listen.wakeword", "p/account", "ui");
      const detected: WakewordDetection[] = [];
      const stream = await f.wake()!.open({ body: "a", signal: new AbortController().signal, onDetection: d => detected.push(d), onError: () => {} });
      mocks.word = "Floppy";
      stream.pushAudio(new Float32Array([1, -1, 0]), 40000);
      expect(mocks.process).not.toHaveBeenCalled();
      stream.pushAudio(new Float32Array([0.5, 0, 0, 0, 0]), 40003);
      expect(mocks.process.mock.calls[0]![0]).toEqual([32767, -32767, 0, 16384]);
      expect(mocks.process).toHaveBeenCalledTimes(2);
      expect(detected).toEqual([{ word: "Floppy", startSample: 16004, endSample: 40004 }]);
      await f.k.stopAll(); stream.close();
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally { await f.k.stopAll(); }
  });
  it("une erreur native Porcupine ne divulgue pas l'AccessKey", async () => {
    const f = await fixture();
    try {
      await f.configure("p", { ...f.paths, apiKey: "secret-do-not-print" }); await f.k.settings.change("slot.listen.wakeword", "p/account", "ui"); mocks.fail = true;
      await expect(f.wake()!.open({ body: "a", signal: new AbortController().signal, onDetection() {}, onError() {} })).rejects.toThrow("initialisation refusée");
    } finally { await f.k.stopAll(); }
  });
});
