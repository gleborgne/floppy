// @vitest-environment happy-dom
// La vraie fenêtre des réglages (settings.js et ses modules, Preact), dans une page simulée, avec un faux pont vers
// l'app. On vérifie ce que l'utilisateur vit : un rafraîchissement des données ne recrée pas la page (le clic sur
// « Retour » marche du premier coup, l'animation d'entrée ne se rejoue pas) et ce qu'on tape ne se perd pas.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const R = resolve(here, "../src/renderer");

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let DEMO: Any;
let pushItems: (d: Any) => void = () => {};
const itemOp = vi.fn(async () => ({ ok: true, text: "ok" }));

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const byText = (sel: string, text: string) => [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(text)) as HTMLElement | undefined;
/** Les données d'exemple, avec la description d'un modèle changée (ce que le noyau envoie quand un modèle se charge). */
const itemsWith = (detail: string) => {
  const d = structuredClone(DEMO.items);
  const gemma = d.providers.find((p: Any) => p.id === "llm-local").items.find((i: Any) => i.id === "gemma");
  gemma.detail = detail;
  return d;
};

beforeAll(async () => {
  const html = readFileSync(resolve(R, "settings.html"), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
  ({ DEMO } = await import("../src/renderer/settings-demo.ts"));
  (window as Any).floppySettings = {
    get: async () => structuredClone(DEMO.settings),
    items: async () => structuredClone(DEMO.items),
    onUpdate: () => {}, onItems: (cb: Any) => { pushItems = cb; }, onFocus: () => {}, onOnboarding: () => {},
    onboardingState: async () => null,
    set: async () => ({ ok: true, text: "" }), itemOp, undo: async () => ({ ok: true }),
  };
  await import("../src/renderer/icons.ts");
  await import("../src/renderer/settings.ts");
  await flush();
});

describe("fenêtre des réglages (Preact)", () => {
  it("un rafraîchissement garde la page : même bouton Retour, pas d'animation rejouée, retour au premier clic", async () => {
    byText("#nav button", "Cerveau")!.click();
    byText(".srow.pick", "Gemma 4 12B")!.click();
    const page = $("#content .pg")!;
    const back = $(".crumbs .back")!;
    expect(page.className).toContain("anim-fwd");
    expect($("#content h2")?.textContent).toBe("Gemma 4 12B");

    pushItems(itemsWith("en cours de chargement"));
    await flush();
    // Les nouvelles données sont là, dans les MÊMES éléments : rien n'a été recréé.
    expect($("#content")!.textContent).toContain("en cours de chargement");
    expect($("#content .pg")).toBe(page);
    expect($(".crumbs .back")).toBe(back);

    back.click();
    expect($(".crumbs")).toBeNull();
    expect($("#content h2")?.textContent).toBe("Cerveau");
    // Une autre page : un nouvel élément, qui entre avec l'animation du retour.
    expect($("#content .pg")).not.toBe(page);
    expect($("#content .pg")!.className).toContain("anim-back");
  });

  it("ce qu'on tape dans le formulaire en place survit aux nouvelles données, puis s'enregistre", async () => {
    byText(".srow.pick", "Gemma 4 12B")!.click();
    const label = byText("#content label", "Nom")!;
    const input = document.getElementById(label.getAttribute("for")!) as HTMLInputElement;
    expect(input.value).toBe("Gemma");
    input.focus();
    input.value = "Mon Gemma";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    pushItems(itemsWith("chargé"));
    await flush();
    input.blur();
    await flush();
    const now = document.getElementById(byText("#content label", "Nom")!.getAttribute("for")!) as HTMLInputElement;
    expect(now).toBe(input);
    expect(now.value).toBe("Mon Gemma");

    itemOp.mockClear();
    now.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(itemOp).toHaveBeenCalledWith(expect.objectContaining({ op: "update", provider: "llm-local", id: "gemma", values: expect.objectContaining({ name: "Mon Gemma" }) }));
    $(".crumbs .back")!.click();
  });

  it("changer d'onglet fait entrer le nouvel onglet ; un rafraîchissement ne le refait pas entrer", async () => {
    byText("#nav button", "Cerveau")!.click();
    const tabs = [...document.querySelectorAll(".ptab")] as HTMLElement[];
    expect(tabs.length).toBeGreaterThan(1);
    const other = tabs.find((x) => !x.classList.contains("on"))!;
    other.click();
    const panel = $(".tabpanel")!;
    expect(panel.className).toContain("tabin");
    pushItems(itemsWith("chargé à nouveau"));
    await flush();
    expect($(".tabpanel")).toBe(panel);
    expect(panel.className).not.toContain("tabin");
  });

  it("chaque rubrique, chaque page d'élément et chaque fenêtre se dessinent sans erreur", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
    window.addEventListener("error", onError);
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
    try {
      const sections = [...document.querySelectorAll("#nav button")].map((b) => b.textContent ?? "");
      expect(sections.length).toBeGreaterThan(3);
      let pages = 0;
      for (const name of sections) {
        byText("#nav button", name)!.click();
        // Tous les onglets de la rubrique, et chaque élément de chacun.
        const tabCount = document.querySelectorAll(".ptab").length || 1;
        for (let ti = 0; ti < tabCount; ti++) {
          (document.querySelectorAll(".ptab")[ti] as HTMLElement | undefined)?.click();
          const rows = document.querySelectorAll("#content .srow.pick").length;
          for (let i = 0; i < rows; i++) {
            (document.querySelectorAll("#content .srow.pick")[i] as HTMLElement).click();
            expect($(".crumbs .back")).not.toBeNull();
            pages++;
            $(".crumbs .back")!.click();
            (document.querySelectorAll(".ptab")[ti] as HTMLElement | undefined)?.click();
          }
        }
        // Les fenêtres : catalogue des plugins, ajout d'un élément, modèles à télécharger.
        const dlg = document.getElementById("editor") as HTMLDialogElement;
        for (const label of ["Ajouter un plugin", "+ Ajouter", "Télécharger des modèles"]) {
          const btn = byText("#content button", label);
          if (!btn) continue;
          btn.click();
          expect(dlg.textContent?.length).toBeGreaterThan(0);
          dlg.close();
        }
      }
      expect(pages).toBeGreaterThan(5);
      pushItems(itemsWith("encore"));
      await flush();
    } finally {
      window.removeEventListener("error", onError);
      spy.mockRestore();
    }
    expect(errors).toEqual([]);
  });

  it("fenêtre d'ajout : ce qu'on tape reste pendant qu'on remplit, l'ajout réussi ferme la fenêtre", async () => {
    byText("#nav button", "Cerveau")!.click();
    const tabs = [...document.querySelectorAll(".ptab")] as HTMLElement[];
    const addGguf = () => [...document.querySelectorAll(".saddbar button")].find((b) => b.textContent === "+ Ajouter") as HTMLElement | undefined;
    for (const tab of tabs) { tab.click(); if (byText(".srow.pick", "Gemma 4 12B") && addGguf()) break; }
    addGguf()!.click();
    const dlg = document.getElementById("editor") as HTMLDialogElement;
    expect(dlg.open).toBe(true);
    const name = document.getElementById(byText("#editor label", "Nom")!.getAttribute("for")!) as HTMLInputElement;
    name.value = "Mistral";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    // Le champ redessine la fenêtre à chaque frappe : c'est toujours le même champ, avec ce qu'on a tapé.
    expect(document.getElementById(byText("#editor label", "Nom")!.getAttribute("for")!)).toBe(name);
    expect(name.value).toBe("Mistral");
    itemOp.mockClear();
    byText("#editor button", "Ajouter")!.click();
    await flush();
    expect(itemOp).toHaveBeenCalledWith(expect.objectContaining({ op: "add", provider: "llm-local", kind: "gguf", values: expect.objectContaining({ name: "Mistral" }) }));
    expect(dlg.open).toBe(false);
    expect($("#toast")!.textContent).toBe("ok");
  });
});
