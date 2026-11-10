import { describe, it, expect } from "vitest";
import type { ProviderSnapshot, SettingInfo } from "@floppy/core";
import { waysOf, wayChange, toolsOf, avatarPreviewOf, WAY_KEYS, TOOLS_PROVIDER } from "../src/onboarding-extras.ts";

const setting = (key: string, value: unknown, over: Partial<SettingInfo> = {}): SettingInfo => ({
  key, label: key, description: key, type: "text", section: "general", group: "g", value, risk: "free", source: "x", ...over,
});
const provider = (id: string, items: ProviderSnapshot["items"], enable = true): ProviderSnapshot => ({
  id, section: "s", layout: "list", capabilities: [], label: id, order: 1, kinds: [], source: "x",
  can: { add: false, update: false, remove: false, enable, child: false, test: false, action: false, search: false }, items,
});

describe("façons d'appeler Floppy (fenêtre Bienvenue)", () => {
  it("mot d'activation : allumé s'il y a une valeur autre que « @none » ; sinon la première option qui rallume", () => {
    const opts = [{ value: "@none", label: "non" }, { value: "wakeword-stt/account", label: "stt" }, { value: "wakeword-porcupine/k", label: "p" }];
    expect(waysOf([setting(WAY_KEYS.wake, "wakeword-sherpa/x", { options: opts })]).wake).toEqual({ on: true, value: "wakeword-sherpa/x", fallback: "wakeword-sherpa/x" });
    expect(waysOf([setting(WAY_KEYS.wake, "@none", { options: opts })]).wake).toEqual({ on: false, value: "@none", fallback: "wakeword-stt/account" });
  });

  it("réglage absent : null (la fenêtre n'invente rien) ; mot d'activation sans option pour l'allumer : null", () => {
    expect(waysOf([])).toEqual({ wake: null, talk: null });
    expect(waysOf([setting(WAY_KEYS.wake, "@none", { options: [{ value: "@none", label: "non" }] })]).wake).toBeNull();
  });

  it("raccourci « Parler » : sa valeur, vide = désactivé, le préréglage sert de valeur par défaut", () => {
    const presets = [{ value: "Ctrl+Alt+F", label: "défaut" }];
    expect(waysOf([setting(WAY_KEYS.talk, "Ctrl+Shift+P", { presets })]).talk).toEqual({ keys: "Ctrl+Shift+P", fallback: "Ctrl+Alt+F" });
    expect(waysOf([setting(WAY_KEYS.talk, "", { presets })]).talk).toEqual({ keys: "", fallback: "Ctrl+Alt+F" });
  });

  it("la fenêtre ne peut changer que ces deux réglages", () => {
    expect(wayChange("wake", "@none")).toEqual({ key: "slot.listen.wakeword", value: "@none" });
    expect(wayChange("talk", "")).toEqual({ key: "raccourci_parler", value: "" });
    expect(wayChange("brain.main", "x")).toBeUndefined();
    expect(wayChange("talk", 12)).toEqual({ key: "raccourci_parler", value: "" });
  });
});

describe("connecteurs (fenêtre Bienvenue)", () => {
  const item = (id: string, over: object = {}) => ({ id, label: id, enabled: true, ...over });
  it("liste les connecteurs avec leur interrupteur ; un élément non modifiable n'est pas activable", () => {
    const p = provider(TOOLS_PROVIDER, [item("web", { detail: "Chercher" }), item("mail", { enabled: false, toggleable: false })]);
    expect(toolsOf([provider("autre", [item("x")]), p])).toEqual({
      provider: TOOLS_PROVIDER,
      items: [{ id: "web", label: "web", detail: "Chercher", enabled: true, toggleable: true }, { id: "mail", label: "mail", enabled: false, toggleable: false }],
    });
  });
  it("le fournisseur ne permet pas d'allumer : rien n'est activable ; absent : liste vide", () => {
    expect(toolsOf([provider(TOOLS_PROVIDER, [item("web")], false)]).items[0]!.toggleable).toBe(false);
    expect(toolsOf([])).toEqual({ provider: TOOLS_PROVIDER, items: [] });
  });
});

describe("aperçu de l'avatar (fenêtre Bienvenue)", () => {
  const png = "data:image/png;base64,AAAA";
  it("l'avatar en service, sinon le premier qui a un aperçu ; rien d'autre qu'une image data:", () => {
    const items = [{ id: "a", label: "a", enabled: true, preview: png }, { id: "b", label: "b", enabled: true, active: true, preview: "data:image/png;base64,BBBB" }];
    expect(avatarPreviewOf([provider("avatars", items)])).toBe("data:image/png;base64,BBBB");
    expect(avatarPreviewOf([provider("avatars", [items[0]!])])).toBe(png);
    expect(avatarPreviewOf([provider("avatars", [{ id: "c", label: "c", enabled: true, preview: "https://x/y.png" }])])).toBeUndefined();
    expect(avatarPreviewOf([])).toBeUndefined();
  });
});
