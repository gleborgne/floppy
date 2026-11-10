// @vitest-environment happy-dom
// Les voix restent toutes accessibles dans la carte de leur modèle.
import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO } from "../src/renderer/settings-demo.ts";

type Any = any;
let pushItems: (data: Any) => void;
let pushSettings: (data: Any) => void;
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const byText = (selector: string, text: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.includes(text))!;

beforeAll(async () => {
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/settings.html"), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
  (window as Any).floppySettings = {
    get: async () => structuredClone(DEMO.settings), items: async () => structuredClone(DEMO.items),
    onUpdate: (cb: Any) => { pushSettings = cb; }, onItems: (cb: Any) => { pushItems = cb; }, onFocus: () => {}, onOnboarding: () => {},
    onboardingState: async () => null, set: async () => ({ ok: true, text: "" }),
    itemOp: async () => ({ ok: true, text: "" }), undo: async () => ({ ok: true }),
  };
  await import("../src/renderer/icons.ts");
  await import("../src/renderer/settings.ts");
  await flush();
});

it("montre toutes les voix sous leur modèle, même après un rafraîchissement", async () => {
  const data: Any = structuredClone(DEMO.items);
  const provider = data.providers.find((p: Any) => p.items.some((i: Any) => i.id === "anna"));
  const anna = provider.items.find((i: Any) => i.id === "anna");
  const extraGroup = { id: "autre-modele", label: "Autre modèle", detail: "0,1 Go · processeur" };
  const extras = [anna.group, extraGroup].flatMap((group) => Array.from({ length: 8 }, (_, i) => ({
    ...anna, id: `${group.id}-${i}`, label: `Voix ${group.id} ${i}`, active: false, group,
  })));
  provider.items.push(...extras, { ...anna, id: "sans-modele", label: "Voix sans modèle", group: undefined, active: false });
  pushItems(data);
  await flush();
  byText("#nav button", "Voix").click();
  const checkGroups = () => {
    expect(document.querySelectorAll("#content .srow.pick")).toHaveLength(provider.items.length);
    expect(document.querySelectorAll("#content .voice-group")).toHaveLength(4);
    for (const voice of extras) {
      const row = byText("#content .srow.pick", voice.label);
      expect(row).toBeDefined();
      const label = typeof voice.group.label === "string" ? voice.group.label : voice.group.label.fr;
      expect(row.closest(".voice-group")?.getAttribute("aria-label")).toBe(label);
      expect(row.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    }
    const active = byText("#content .srow.pick", "Anna");
    expect(active.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(active.closest(".voice-group")?.querySelector("header .rs")?.textContent).toBe("chargé");
    const idle = byText("#content .voice-group", "Autre modèle");
    expect(idle.querySelector("header")?.textContent).toContain(extraGroup.detail);
    expect(idle.querySelector("header .rs")?.textContent).toBe("en veille");
    expect(byText("#content .srow.pick", "Voix sans modèle").closest(".voice-group")).toBeNull();
    expect(document.querySelector("#content")!.textContent).not.toContain("autres dans");
    expect([...document.querySelectorAll("#content .shead")].some((e) => e.textContent?.startsWith("Modèles"))).toBe(false);
  };
  checkGroups();
  pushItems(structuredClone(data));
  await flush();
  checkGroups();
  const last = extras.at(-1)!;
  byText("#content .srow.pick", last.label).click();
  expect(document.querySelector("#content h2")?.textContent).toBe(last.label);
  document.querySelector<HTMLElement>(".crumbs .back")!.click();
});

it("garde les réglages communs au-dessus des onglets des moteurs", () => {
  byText("#nav button", "Voix").click();
  const tone = document.querySelector('#content input[aria-label="Ton"]')!;
  const tabs = document.querySelector('#content [role="tablist"]')!;
  expect(tone.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("garde Général au-dessus des onglets de page quand on change d'onglet", async () => {
  const settings: Any = structuredClone(DEMO.settings);
  const tone = settings.list.find((s: Any) => s.key === "tone");
  tone.group = { fr: "Général", en: "General" };
  settings.list.push(...Array.from({ length: 3 }, (_, i) => ({
    ...tone, key: `test-voix-${i}`, label: `Réglage ${i}`, group: "Autres réglages",
  })));
  pushSettings(settings);
  await flush();
  byText("#content .ptab", "Voix").click();
  const general = byText("#content .sgroup", "Général");
  const tabs = document.querySelector("#content .ptabs")!;
  expect(general.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  byText("#content .ptab", "Autres réglages").click();
  expect(byText("#content .sgroup", "Général")).toBe(general);
  expect(document.querySelector("#content .tabpanel")?.textContent).toContain("Réglage 2");
});
