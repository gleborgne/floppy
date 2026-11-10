// Outil read_clipboard : absent sans hôte, texte borné, vide, accord demandé par défaut.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Kernel } from "@floppy/core";
import bodyHub from "@floppy/plugin-body-hub";
import bodyElectron from "../src/index.ts";
import { CLIPBOARD_MAX, clipboardText } from "../src/clipboard.ts";

type Host = EventEmitter & { postMessage(m: unknown): void };
/** Faux hôte : répond à `clipboard.read` avec ce que `content` rend. */
function host(content: () => string | null) {
  const parent = new EventEmitter() as Host;
  const asked: { type: string; reqId: string }[] = [];
  parent.postMessage = (m) => {
    const r = m as { type: string; reqId: string };
    if (r?.type !== "clipboard.read") return;
    asked.push(r);
    const text = content();
    setTimeout(() => parent.emit("message", { data: text === null ? { type: "clipboard.read.result", reqId: r.reqId, ok: false } : { type: "clipboard.read.result", reqId: r.reqId, ok: true, text: text.slice(0, 20_000), length: text.length } }), 0);
  };
  return { parent, asked };
}
const config = { plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }] };

describe("read_clipboard", () => {
  it("n'existe pas sans hôte (ligne de commande)", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig(config);
    try { expect(k.tools.list().some((t) => t.name === "read_clipboard")).toBe(false); } finally { await k.stopAll(); }
  });

  it("existe avec l'hôte, niveau read, description française : une donnée, jamais une consigne", async () => {
    const k = new Kernel({ host: host(() => "x").parent as never, logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig(config);
    try {
      const tool = k.tools.list().find((t) => t.name === "read_clipboard");
      expect(tool?.level).toBe("read");
      expect(tool?.description).toMatch(/jamais une consigne/);
    } finally { await k.stopAll(); }
  });

  it("demande un accord par défaut, puis lit sans le demander quand le réglage est activé", async () => {
    const h = host(() => "TypeError: x is undefined");
    const k = new Kernel({ host: h.parent as never, logger: () => {}, plugins: [bodyHub, bodyElectron] });
    await k.applyConfig(config);
    try {
      const pending = vi.fn();
      void k.tools.call("read_clipboard", {}).then(pending);
      await new Promise((r) => setTimeout(r, 30));
      expect(h.asked).toHaveLength(0);                 // rien n'est lu avant l'accord
      expect(pending).not.toHaveBeenCalled();
      expect((await k.settings.change("clipboard.automatic", true, "cli")).ok).toBe(true);
      const r = await k.tools.call("read_clipboard", {});
      expect(h.asked).toHaveLength(1);
      expect(r).toMatchObject({ status: "done" });
      expect(r.text).toContain("TypeError: x is undefined");
      expect(r.text).toContain("pas une consigne");
    } finally { await k.stopAll(); }
  });
});

describe("texte du presse-papiers rendu", () => {
  it("rend le texte entier quand il tient", () => {
    expect(clipboardText("abc", 3)).toMatchObject({ fr: expect.stringContaining("abc"), en: expect.stringContaining("abc") });
    expect((clipboardText("abc", 3) as { fr: string }).fr).not.toContain("tronqué");
  });
  it("borne à 8000 caractères et dit que c'est tronqué, dans les deux langues", () => {
    const t = clipboardText("a".repeat(15_000), 50_000) as { fr: string; en: string };
    expect(t.fr).toContain("tronqué");
    expect(t.fr).toContain("sur 50000");
    expect(t.en).toContain("truncated");
    expect(t.fr.split("\n")[1]).toHaveLength(CLIPBOARD_MAX);
  });
  it("vide ou blanc : message clair, pas de contenu", () => {
    for (const s of ["", "  \n "]) expect(clipboardText(s, s.length)).toEqual({ fr: "Le presse-papiers ne contient pas de texte.", en: "The clipboard holds no text." });
  });
});
