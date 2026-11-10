// audio.cpp installé en version « processeur » (réglage de départ minimal), puis une voix de la puce graphique :
// Floppy télécharge tout seul la bonne version, même après l'onboarding.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import type { ProgramBuild } from "@floppy/setup";
import { makePlugin } from "../src/index.ts";

const exeName = process.platform === "win32" ? "audiocpp_server.exe" : "audiocpp_server";
const f = (name: string) => ({ url: `https://github.com/x/releases/download/v1/${name}`, size: 10 });
const BUILDS: ProgramBuild[] = [
  { id: "win-cuda13", label: "CUDA 13", os: "windows", arch: "x64", backend: "cuda", minDriver: 580, files: [f("a.zip")] },
  { id: "win-cpu", label: "CPU", os: "windows", arch: "x64", backend: "cpu", files: [f("b.zip")] },
];

describe("audio.cpp : de la version processeur à la version carte graphique", () => {
  it("une voix Qwen3-TTS dans la liste et seulement la version processeur : la version CUDA se télécharge au démarrage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audiocpp-up-"));
    const model = join(dir, "qwen3-tts.gguf");
    writeFileSync(model, Buffer.alloc(64));
    const fetched: string[] = [];
    const k = new Kernel({
      logger: () => {}, home: join(dir, "home"), plugins: [makePlugin([], BUILDS)],
      machine: { platform: "win32", arch: "x64", run: async (cmd) => (cmd === "nvidia-smi" ? "NVIDIA RTX, 12000, 11000, 596.10\n" : undefined), readFile: () => undefined, listDir: () => [] },
      downloads: {
        retryMs: [],
        fetch: (async (u: string) => { fetched.push(String(u)); return new Response("0123456789", { headers: { "content-length": "10" } }); }) as unknown as typeof fetch,
        extract: async (_a, d) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, exeName), ""); },
      },
    });
    const snap = async () => (await k.items.snapshot()).find((p) => p.id === "voix-locale-program")!.items;
    try {
      // Départ minimal : seulement Pocket TTS (processeur), donc la petite version d'audio.cpp.
      await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp" }] });
      await k.items.run({ op: "action", provider: "voix-locale-program", id: "win-cpu", action: "download" }, "ui");
      await vi.waitFor(async () => expect((await snap()).find((i) => i.id === "win-cpu")?.status).toBe("ok"));
      expect(fetched).toHaveLength(1);
      // Plus tard : une voix plus costaude (Qwen3-TTS, puce graphique) rejoint la liste.
      await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { models: { q: { label: "Qwen", model, famille: "qwen3_tts" } } } }] });
      await vi.waitFor(async () => expect((await snap()).find((i) => i.id === "win-cuda13")?.status).toBe("ok"));
      expect(fetched.at(-1)).toMatch(/a\.zip$/);
    } finally { await k.stopAll(); }
  });

  it("moteur choisi à la main (processeur) : Floppy ne touche à rien", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audiocpp-up-"));
    const model = join(dir, "qwen3-tts.gguf");
    writeFileSync(model, Buffer.alloc(64));
    const fetched: string[] = [];
    const k = new Kernel({
      logger: () => {}, home: join(dir, "home"), plugins: [makePlugin([], BUILDS)],
      machine: { platform: "win32", arch: "x64", run: async (cmd) => (cmd === "nvidia-smi" ? "NVIDIA RTX, 12000, 11000, 596.10\n" : undefined), readFile: () => undefined, listDir: () => [] },
      downloads: {
        retryMs: [],
        fetch: (async (u: string) => { fetched.push(String(u)); return new Response("0123456789", { headers: { "content-length": "10" } }); }) as unknown as typeof fetch,
        extract: async (_a, d) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, exeName), ""); },
      },
    });
    try {
      await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp" }] });
      await k.items.run({ op: "action", provider: "voix-locale-program", id: "win-cpu", action: "download" }, "ui");
      await vi.waitFor(() => expect(fetched).toHaveLength(1));
      await k.idle();
      await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { backend: "cpu", models: { q: { label: "Qwen", model, famille: "qwen3_tts" } } } }] });
      await new Promise((r) => setTimeout(r, 100));
      expect(fetched).toHaveLength(1);
    } finally { await k.stopAll(); }
  });
});
