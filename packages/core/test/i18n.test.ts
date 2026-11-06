// Deux langues : l'interface (ce qu'on lit) et l'assistant (ce qu'il dit). Le noyau choisit selon l'origine.
import { describe, it, expect } from "vitest";
import { Kernel, definePlugin, T, TextError, tr, type ToolDef } from "../src/index.ts";

const plugin = definePlugin({
  manifest: { id: "p", version: "0", licence: "MIT" },
  apply(ctx) {
    let on = false;
    ctx.items.declare({
      id: "prov", section: "general", label: T("Fournisseur", "Provider"), kinds: [],
      list: () => [{ id: "x", label: "X", enabled: on }],
      setEnabled: async (_id, v) => { on = v; return { ok: true, text: T("Activé.", "Enabled.") }; },
      action: async () => { throw new TextError(T("Fichier introuvable", "File not found")); },
    });
    ctx.settings.declare([{
      key: "vitesse", section: "general", label: T("Vitesse", "Speed"), description: "", type: "boolean", risk: "free",
      get: () => on, set: (v) => { on = Boolean(v); },
    }]);
    const tool: ToolDef = {
      name: "dire", description: "", inputSchema: { type: "object" }, level: "read",
      waitPhrase: T("Une seconde.", "One moment."),
      handler: async () => ({ status: "done", text: T("Fait.", "Done.") }),
    };
    ctx.tools.register([tool]);
  },
});

async function kernel(): Promise<Kernel> {
  const k = new Kernel({ logger: () => {}, plugins: [plugin] });
  await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
  return k;
}

describe("langues de l'interface et de l'assistant", () => {
  it("tr : langue demandée, sinon français", () => {
    expect(tr(T("Oui", "Yes"), "en")).toBe("Yes");
    expect(tr(T("Oui", "Yes"), "de")).toBe("Oui");
    expect(tr("Texte", "en")).toBe("Texte");
  });

  it("résultats des éléments : langue de l'interface pour un clic, de l'assistant pour la voix", async () => {
    const k = await kernel();
    expect((await k.items.run({ op: "action", provider: "prov", id: "x", action: "a" }, "ui")).text).toBe("Fichier introuvable");
    await k.settings.change("langue_interface", "en", "ui");
    expect((await k.items.run({ op: "action", provider: "prov", id: "x", action: "a" }, "ui")).text).toBe("File not found");
    expect((await k.items.run({ op: "enable", provider: "prov", id: "x", on: true }, "voice")).text).toBe("Activé.");
    await k.stopAll();
  });

  it("réglages et outils suivent la langue de l'assistant (réglage langue_assistant)", async () => {
    const k = await kernel();
    expect((await k.settings.change("vitesse", "oui", "voice")).text).toBe("Vitesse : oui.");
    expect((await k.settings.change("langue_assistant", "english", "ui")).ok).toBe(true);
    await k.idle();
    expect(k.assistantSettings.language).toBe("en");
    expect((await k.settings.change("vitesse", "yes", "voice")).text).toBe("Speed: yes.");
    expect((await k.tools.call("dire", {})).text).toBe("Done.");
    expect(k.tools.list().find((t) => t.name === "dire")?.waitPhrase).toBe("One moment.");
    await k.stopAll();
  });
});
