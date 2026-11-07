// Programmes lancés par ctx.spawn : notés tant qu'ils tournent ; ceux restés d'une session tuée de force sont arrêtés.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, reapOrphans, programBase, type Context } from "../src/index.ts";

describe("programmes lancés", () => {
  it("note le programme pendant qu'il tourne, l'oublie à sa fin, et retire sa fermeture", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-children-"));
    let ctx!: Context;
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT", permissions: { exec: [programBase(process.execPath)] } },
      apply(c) { ctx = c; },
    });
    const k = new Kernel({ logger: () => {}, home, plugins: [p] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    const child = ctx.spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
    expect(k.children.list().map((r) => [r.pid, r.owner])).toEqual([[child.pid, "p"]]);
    expect(JSON.parse(readFileSync(join(home, "children.json"), "utf8"))).toHaveLength(1);
    await new Promise((r) => child.once("exit", r));
    expect(k.children.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "children.json"), "utf8"))).toEqual([]);
    await k.stopAll();
  });

  it("arrête seulement un programme au même nom, démarré au même moment, dont le noyau n'est plus là", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-children-"));
    const file = join(home, "children.json");
    const t = Date.parse("2026-11-07T10:00:00Z");
    const at = new Date(t).toISOString();
    writeFileSync(file, JSON.stringify([
      { pid: 101, name: "llama-server", owner: "llm", at, kernel: 9001 },   // noyau mort, même programme : arrêté
      { pid: 102, name: "audio-server", owner: "tts", at, kernel: 9001 },   // numéro repris par un autre programme : laissé
      { pid: 103, name: "llama-server", owner: "llm", at, kernel: 9001 },   // fini : rien à faire
      { pid: 104, name: "claude", owner: "claude", at, kernel: 9001 },      // même nom, mais démarré une heure après : laissé
      { pid: 105, name: "llama-server", owner: "llm", at, kernel: 9002 },   // noyau d'une autre instance en marche : laissé
    ]));
    const running: Record<number, { name: string; startedAt?: number }> = {
      101: { name: "llama-server", startedAt: t + 800 }, 102: { name: "notepad", startedAt: t },
      104: { name: "claude", startedAt: t + 3_600_000 }, 105: { name: "llama-server", startedAt: t },
    };
    const killed: number[] = [];
    const out = await reapOrphans(file, { infoOf: async (pid) => running[pid], alive: (pid) => pid === 9002, kill: async (pid) => { killed.push(pid); } });
    expect(killed).toEqual([101]);
    expect(out.map((r) => r.pid)).toEqual([101]);
    // La liste ne garde que les programmes de l'instance encore en marche : rien n'est arrêté deux fois.
    expect(JSON.parse(readFileSync(file, "utf8")).map((r: { pid: number }) => r.pid)).toEqual([105]);
  });

  it("nom du programme : sans dossier ni extension", () => {
    expect(programBase("C:/tools/Llama-Server.EXE")).toBe("llama-server");
    expect(programBase("/usr/bin/node")).toBe("node");
  });
});
