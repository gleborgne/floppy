import { describe, it, expect, afterEach } from "vitest";
import { Kernel } from "@floppy/core";
import { createBrowserPlugin, checkUrl } from "../src/index.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(config: Record<string, unknown> = {}) {
  const opened: string[] = [];
  const k = new Kernel({ logger: () => {}, plugins: [createBrowserPlugin(async (u) => { opened.push(u); })] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "browser", plugin: "browser", config }] });
  return { k, opened };
}

describe("plugin navigateur", () => {
  it("ouvre une adresse http(s) après accord ; refuse les autres schémas", async () => {
    const { k, opened } = await start();
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, true, "test"); });
    expect((await k.tools.call("ouvrir_url", { url: "https://dev.azure.com/x/_git/r/pullrequest/1" })).status).toBe("done");
    expect(opened).toEqual(["https://dev.azure.com/x/_git/r/pullrequest/1"]);
    expect((await k.tools.call("ouvrir_url", { url: "file:///C:/Windows/system32/calc.exe" })).status).toBe("failed");
    expect((await k.tools.call("ouvrir_url", { url: "javascript:alert(1)" })).status).toBe("failed");
    expect(opened.length).toBe(1);
  });

  it("sans accord demandé : niveau lecture", async () => {
    const { k } = await start({ ask: false });
    expect(k.tools.list().find((t) => t.name === "ouvrir_url")!.level).toBe("read");
  });

  it("est une application de la rubrique Connecteurs, qu'on peut retirer", async () => {
    const { k } = await start();
    const P = "apps-connecteurs";
    expect(k.items.provider(P)!.kinds!.map((x) => x.id)).toEqual(["browser"]);
    await k.items.run({ op: "remove", provider: P, id: "browser" }, "ui");
    expect(k.tools.list().some((t) => t.name === "ouvrir_url")).toBe(false);
  });

  it("checkUrl", () => {
    expect(checkUrl("http://a.b/c").host).toBe("a.b");
    expect(() => checkUrl("ftp://x")).toThrow();
  });
});
