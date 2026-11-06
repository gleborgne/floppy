// Autres appareils : un jeton nommé par appareil, montré une seule fois ; révoqué à la suppression.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Kernel } from "@floppy/core";
import bodyHub from "@floppy/plugin-body-hub";
import bodyWs from "../src/index.ts";

const home = mkdtempSync(join(tmpdir(), "ws-"));
const oldHome = process.env.FLOPPY_HOME;
let k: Kernel | undefined;
afterEach(async () => {
  await k?.stopAll();
  if (oldHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = oldHome;
});

const tryConnect = (url: string) => new Promise<"open" | "refused">((res) => {
  const ws = new WebSocket(url);
  ws.on("open", () => { ws.close(); res("open"); });
  ws.on("unexpected-response", () => res("refused"));
  ws.on("error", () => res("refused"));
});

describe("body-ws : appareils", () => {
  it("add crée un jeton montré une seule fois ; il ouvre la connexion ; remove le révoque", async () => {
    process.env.FLOPPY_HOME = home;
    k = new Kernel({ logger: () => {}, home, plugins: [bodyHub, bodyWs] });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      plugins: [{ id: "body", plugin: "body-hub" }, { id: "ws", plugin: "body-ws", config: { port: 0 } }] });
    const p = (await k.items.snapshot()).find((x) => x.id === "ws-devices")!;
    expect(p.section).toBe("corps");
    expect(p.kinds.map((x) => x.id)).toEqual(["device"]);
    expect((await k.items.run({ op: "add", provider: "ws-devices", kind: "device", values: {} }, "ui")).ok).toBe(false);
    const r = await k.items.run({ op: "add", provider: "ws-devices", kind: "device", values: { name: "Mon téléphone" } }, "ui");
    expect(r.ok).toBe(true);
    const m = /ws:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(r.text)!;
    expect(m).toBeTruthy();
    const base = `ws://127.0.0.1:${m[1]}/`;
    // le jeton n'est écrit en clair nulle part (seule son empreinte est gardée)
    expect(readFileSync(join(home, "items", "body-ws-devices.json"), "utf8")).not.toContain(m[2]!);
    expect(await tryConnect(`${base}?token=${m[2]}`)).toBe("open");
    expect(await tryConnect(`${base}?token=nope`)).toBe("refused");
    const list = (await k.items.snapshot()).find((x) => x.id === "ws-devices")!.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Mon téléphone", removable: true });
    expect(JSON.stringify(list)).not.toContain(m[2]!);
    expect((await k.items.run({ op: "remove", provider: "ws-devices", id: list[0]!.id }, "ui")).ok).toBe(true);
    expect(await tryConnect(`${base}?token=${m[2]}`)).toBe("refused");
  });
});

describe("body-ws : robustesse et identité", () => {
  it("messages invalides : réponse error, pas de crash ; l'id vient du jeton, pas du hello", async () => {
    process.env.FLOPPY_HOME = home;
    k = new Kernel({ logger: () => {}, plugins: [bodyHub, bodyWs], home });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      plugins: [{ id: "body", plugin: "body-hub" }, { id: "ws", plugin: "body-ws", config: { port: 0 } }] });
    const { port, token } = JSON.parse(readFileSync(join(home, "body-ws.json"), "utf8")) as { port: number; token: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const got: { type: string }[] = [];
    ws.on("message", (d, bin) => { if (!bin) got.push(JSON.parse(String(d))); });
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    ws.send("null");
    ws.send("42");
    ws.send("pas du json");
    ws.send(JSON.stringify({ type: "hello", id: "x", name: "n", version: "1" })); // sans capabilities
    await vi.waitFor(() => expect(got.filter((m) => m.type === "error")).toHaveLength(4));
    ws.send(JSON.stringify({ type: "hello", id: "avatar", name: "Pirate", version: "1", capabilities: ["text"], managed: true }));
    await vi.waitFor(() => expect(got.some((m) => m.type === "welcome")).toBe(true));
    const hub = k.service<{ sessions(): { id: string }[] }>("body")!;
    expect(hub.sessions().map((s) => s.id)).toEqual(["ws-1"]);
    ws.close();
  });
});

describe("body-ws : désactiver sans supprimer", () => {
  it("un appareil désactivé garde son jeton mais ne se branche plus ; il n'est pas listé deux fois", async () => {
    const h = mkdtempSync(join(tmpdir(), "ws-off-"));
    process.env.FLOPPY_HOME = h;
    k = new Kernel({ logger: () => {}, plugins: [bodyHub, bodyWs], home: h });
    await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      plugins: [{ id: "body", plugin: "body-hub" }, { id: "ws", plugin: "body-ws", config: { port: 0 } }] });
    const r = await k.items.run({ op: "add", provider: "ws-devices", kind: "device", values: { name: "Tablette" } }, "ui");
    const m = /ws:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(r.text)!;
    const url = `ws://127.0.0.1:${m[1]}/?token=${m[2]}`;
    const id = (await k.items.snapshot()).find((x) => x.id === "ws-devices")!.items[0]!.id;

    // branché : listé dans « Autres appareils » seulement, pas aussi dans « Corps »
    const ws = new WebSocket(url);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    ws.send(JSON.stringify({ type: "hello", id: "x", name: "Tablette", version: "1", capabilities: ["text"] }));
    await vi.waitFor(async () => expect((await k!.items.snapshot()).find((x) => x.id === "ws-devices")!.items[0]!.status).toBe("ok"));
    const bodies = (await k.items.snapshot()).find((x) => x.id === "bodies")!.items;
    expect(bodies.some((b) => b.label === "Tablette")).toBe(false);

    const off = await k.items.run({ op: "enable", provider: "ws-devices", id, on: false }, "ui");
    expect(off.ok).toBe(true);
    const item = (await k.items.snapshot()).find((x) => x.id === "ws-devices")!.items[0]!;
    expect(item).toMatchObject({ enabled: false, removable: true });
    expect(await tryConnect(url)).toBe("refused");

    expect((await k.items.run({ op: "enable", provider: "ws-devices", id, on: true }, "ui")).ok).toBe(true);
    expect(await tryConnect(url)).toBe("open");
    ws.terminate();
  });
});
