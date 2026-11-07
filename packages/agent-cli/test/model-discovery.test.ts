import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { killTree, type Context } from "@floppy/core";
import { discoverClaudeModels, discoverCodexModels, discoverAgyModels } from "../src/model-discovery.ts";

vi.mock("@floppy/core", async (original) => ({ ...await original<object>(), killTree: vi.fn(async () => {}) }));

const cmd = { exe: "agent", args: [], cwd: ".", env: {}, timeoutMs: 1000 };
function transport(reply: (request: any) => unknown) {
  const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const requests: any[] = [];
  p.stdin.on("data", (data) => {
    const request = JSON.parse(String(data)); requests.push(request);
    const response = reply(request);
    if (response) queueMicrotask(() => p.stdout.write(JSON.stringify(response) + "\n"));
  });
  let stop: () => Promise<void> = async () => {};
  const ctx = { spawn: vi.fn(() => p), effect(fn: () => Promise<void>) { stop = fn; return fn; } } as unknown as Context;
  return { ctx, p, requests, stop: () => stop() };
}

describe("découverte des modèles sans inférence", () => {
  it("Claude ne reçoit que initialize, et rend les alias du sélecteur", async () => {
    const t = transport((r) => ({ type: "control_response", response: { request_id: r.request_id, subtype: "success", response: {
      models: [{ value: "sonnet", resolvedModel: "claude-version", displayName: "Sonnet" }],
    } } }));
    expect(await discoverClaudeModels(t.ctx, cmd)).toEqual([{ id: "sonnet", label: "Sonnet" }]);
    expect(t.requests).toEqual([{ type: "control_request", request_id: "floppy-models", request: { subtype: "initialize" } }]);
    expect(killTree).toHaveBeenCalledWith(t.p);
  });

  it("Codex suit les pages, emploie model et ignore les entrées cachées ou mal formées", async () => {
    const t = transport((r) => r.method === "initialize" ? { id: r.id, result: {} } : r.method === "model/list" ? {
      id: r.id, result: r.params.cursor ? { data: [{ model: "next", displayName: "Next" }], nextCursor: null } : {
        data: [{ id: "opaque", model: "luna", displayName: "Luna" }, { model: "hidden", displayName: "Hidden", hidden: true }, {}], nextCursor: "page2",
      },
    } : undefined);
    expect(await discoverCodexModels(t.ctx, cmd)).toEqual([{ id: "luna", label: "Luna" }, { id: "next", label: "Next" }]);
    expect(t.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
    expect(t.requests.at(-1).params).toMatchObject({ includeHidden: false, cursor: "page2" });
  });

  it("refuse une pagination en boucle et une erreur RPC, puis ferme le processus", async () => {
    const loop = transport((r) => ({ id: r.id, result: r.method === "initialize" ? {} : { data: [], nextCursor: "same" } }));
    await expect(discoverCodexModels(loop.ctx, cmd)).rejects.toThrow("pagination");
    const denied = transport((r) => ({ id: r.id, error: { message: "refus" } }));
    await expect(discoverCodexModels(denied.ctx, cmd)).rejects.toThrow("refuse");
    expect(killTree).toHaveBeenCalledWith(loop.p);
    expect(killTree).toHaveBeenCalledWith(denied.p);
  });

  it("borne le silence, rejette la fin prématurée et annule à l'arrêt du plugin", async () => {
    const silent = transport(() => undefined);
    await expect(discoverClaudeModels(silent.ctx, { ...cmd, timeoutMs: 20 })).rejects.toThrow("délai");
    expect(killTree).toHaveBeenCalledWith(silent.p);
    const ended = transport(() => undefined);
    const pending = discoverCodexModels(ended.ctx, cmd);
    ended.p.emit("exit", 1);
    await expect(pending).rejects.toThrow("arrêté");
    const stopped = transport(() => undefined);
    const pendingStop = discoverClaudeModels(stopped.ctx, cmd);
    const rejection = expect(pendingStop).rejects.toThrow("arrêtée");
    await stopped.stop();
    await rejection;
  });

  it("Antigravity lit seulement command.data.models et refuse une réponse en erreur", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: JSON.stringify({ status: "SUCCESS", command: { data: { models: [{ id: "gemini-new", label: "Gemini New" }] } } }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: "ERROR" }) });
    const ctx = { exec } as unknown as Context;
    expect(await discoverAgyModels(ctx, cmd)).toEqual([{ id: "gemini-new", label: "Gemini New" }]);
    await expect(discoverAgyModels(ctx, cmd)).rejects.toThrow("refuse");
    expect(exec).toHaveBeenCalledWith("agent", [], expect.objectContaining({ timeoutMs: 1000, maxBuffer: 2 * 1024 * 1024 }));
  });
});
