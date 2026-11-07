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

  it("arrête seulement un programme qui tourne encore sous le même nom", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-children-"));
    const file = join(home, "children.json");
    writeFileSync(file, JSON.stringify([
      { pid: 101, name: "llama-server", owner: "llm", at: "" },   // tourne encore : arrêté
      { pid: 102, name: "audio-server", owner: "tts", at: "" },   // numéro repris par un autre programme : laissé
      { pid: 103, name: "llama-server", owner: "llm", at: "" },   // fini : rien à faire
    ]));
    const running: Record<number, string> = { 101: "llama-server", 102: "notepad" };
    const killed: number[] = [];
    const out = await reapOrphans(file, { nameOf: async (pid) => running[pid], kill: async (pid) => { killed.push(pid); } });
    expect(killed).toEqual([101]);
    expect(out.map((r) => r.pid)).toEqual([101]);
  });

  it("nom du programme : sans dossier ni extension", () => {
    expect(programBase("C:/tools/Llama-Server.EXE")).toBe("llama-server");
    expect(programBase("/usr/bin/node")).toBe("node");
  });
});
