// @vitest-environment happy-dom
// La vraie fenêtre « Bienvenue » (onboarding.ts et ses modules), dans une page simulée, avec un faux pont vers l'app :
// le plan arrive, l'écran « Bonjour » s'affiche et l'écoute se prépare une fois ; chaque écran suit ; « Terminer » envoie
// la sélection choisie à `apply`.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const R = resolve(here, "../src/renderer");

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const GIB = 1024 ** 3;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const all = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const byText = (sel: string, text: string) => all(sel).find((e) => e.textContent?.includes(text));
const press = async (sel: string, text: string) => { const el = byText(sel, text); if (!el) throw new Error(`introuvable : ${sel} « ${text} »`); el.click(); await flush(); };

const choice = (value: string, label: string, over: object = {}) => ({ value, kind: "local", label, fits: true, installed: false, size: 0, recommended: false, ...over });
const makePlan = (language: "fr" | "en", state: Any = { phase: "idle", rows: [], notes: [] }) => ({
  machine: { gpu: { name: "Puce" }, memory: "dedicated", modelBytes: 16 * GIB, ramBytes: 32 * GIB, sources: ["probe"] },
  language, lang: language, home: "~/Floppy", cloudBrains: [], agents: [], state,
  choices: {
    brain: [choice("llm/gemma", { fr: "Gemma", en: "Gemma" }, { recommended: true, size: 9 * GIB }), choice("llm/qwen", "Qwen", { size: 3 * GIB }), choice("claude/opus", "Opus", { kind: "cloud", installed: true })],
    stt: [choice("sherpa/parakeet", "Parakeet", { recommended: true, size: 600e6, language: "good", description: { fr: "Comprend bien le français.", en: "Understands French well." } }), choice("sherpa/whisper", "Whisper")],
    tts: [
      choice("audiocpp/qwen3", "Qwen3-TTS", { recommended: true, size: 2 * GIB, sample: "https://x/qwen.mp3", language: "poor" }),
      choice("system/anna", "Voix de l'ordinateur", { kind: "offered", installed: true }),
      choice("@none", { fr: "Pas de voix (réponses écrites)", en: "No voice (written replies)" }, { kind: "none", installed: true }),
    ],
  },
  recommended: { brain: "llm/gemma", stt: "sherpa/parakeet", tts: "audiocpp/qwen3" },
});
const extras = {
  ways: { wake: { on: true, value: "wakeword-stt/account", fallback: "wakeword-stt/account" }, talk: { keys: "Ctrl+Alt+F", fallback: "Ctrl+Alt+F" } },
  tools: { provider: "apps-connectors", items: [{ id: "web", label: "Chercher sur internet", detail: "Il fait quel temps ?", enabled: true, toggleable: true }, { id: "mail", label: "Courrier", enabled: false, toggleable: true }] },
};

const apply = vi.fn(async (_selection: Any) => ({ ok: true }));
// Compteur simple : le plan est lu avant le premier test (beforeAll).
let prepared = 0;
const prepareListening = async () => { prepared++; return { ok: true }; };
const setLanguage = vi.fn(async (lang: string) => ({ ok: true, value: makePlan(lang as "fr" | "en") }));
const setWay = vi.fn(async () => ({ ok: true }));
const setTool = vi.fn(async () => ({ ok: true }));
let pushState: (s: Any) => void = () => {};

beforeAll(async () => {
  const html = readFileSync(resolve(R, "onboarding.html"), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
  (window as Any).floppyOnboarding = {
    plan: async () => ({ ok: true, value: makePlan("fr") }), setLanguage, prepareListening, extras: async () => ({ ok: true, value: extras }),
    setWay, setTool, apply, skip: async () => ({ ok: true }), chooseHome: async () => ({ ok: false, canceled: true }),
    close: vi.fn(), openSettings: vi.fn(), onState: (cb: Any) => { pushState = cb; return () => {}; },
  };
  await import("../src/renderer/onboarding.ts");
  await flush();
});

describe("fenêtre Bienvenue (vraie page)", () => {
  it("le plan arrive : l'écran Bonjour s'affiche et l'écoute se prépare une seule fois", () => {
    expect($("h1")?.textContent).toBe("Bonjour, moi c'est Floppy.");
    expect($("#bubble")?.textContent).toContain("Salut");
    expect(all("#pieces li")).toHaveLength(4);
    expect(prepared).toBe(1);
    expect(document.documentElement.lang).toBe("fr");
    expect(byText("#content", "Il est assez costaud")).toBeTruthy();
    // Le détail de la machine est derrière « Voir le détail ».
    expect(byText("#content", "Puce graphique")).toBeUndefined();
  });

  it("« Voir le détail » montre la machine ; la langue change avec setLanguage et règle la langue de la fenêtre", async () => {
    await press("#content button", "Voir le détail");
    expect(byText("#content", "Puce graphique")).toBeTruthy();
    await press("#content button", "Changer…");
    await press("#content [role=radio]", "English");
    expect(setLanguage).toHaveBeenCalledWith("en", {});
    expect($("h1")?.textContent).toBe("Hi, I'm Floppy.");
    expect(document.documentElement.lang).toBe("en");
    expect(prepared).toBe(1);
    await press("#content button", "Change…");
    await press("#content [role=radio]", "Français");
    expect($("h1")?.textContent).toBe("Bonjour, moi c'est Floppy.");
  });

  it("Continuer mène au cerveau avec le recommandé coché ; « En ligne » montre les cerveaux du cloud", async () => {
    await press("#actions button", "C'est parti");
    expect($("h1")?.textContent).toBe("Quel cerveau tu me donnes ?");
    const checked = all('#content [role=radio][aria-checked="true"]').filter((e) => e.classList.contains("pick"));
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain("Gemma");
    expect(checked[0]!.textContent).toContain("Recommandé");
    expect(checked[0]!.textContent).toContain("À télécharger : 9 Go");
    expect(byText("#content .pick", "Opus")).toBeUndefined();
    await press("#content .seg button", "En ligne");
    expect(byText("#content .pick", "Opus")).toBeTruthy();
    expect(byText("#content .pick", "Gemma")).toBeUndefined();
    await press("#content .seg button", "Chez toi");
    expect($("#pieces li.current")?.textContent).toContain("Question 1 sur 4");
  });

  it("oreilles : le modèle d'écoute, les façons d'appeler (vrais réglages) et l'essai du micro", async () => {
    await press("#actions button", "Continuer");
    expect($("h1")?.textContent).toBe("Comment tu m'appelles ?");
    expect(byText("#content", "Pour comprendre tes mots : Parakeet")).toBeTruthy();
    expect(byText("#content", "Appuie sur Ctrl+Alt+F")).toBeTruthy();
    // Pas de micro dans la page simulée : la fenêtre le dit, sans planter.
    expect(byText("#content .mic", "Je ne trouve pas de micro")).toBeTruthy();
    await press("#content button", "Changer de modèle");
    expect(all('#content [role=radio]').filter((e) => e.classList.contains("pick"))).toHaveLength(2);
    await press("#content .pick", "Whisper");
    expect(byText("#content", "Pour comprendre tes mots : Whisper")).toBeTruthy();
    await press("#content [role=switch]", "");
    expect(setWay).toHaveBeenCalledWith("wake", "@none");
    all("#content [role=switch]")[1]!.click();
    await flush();
    expect(setWay).toHaveBeenCalledWith("talk", "");
  });

  it("oreilles pas encore téléchargées : la barre d'avancement vient de l'état d'installation", async () => {
    pushState({ phase: "idle", notes: [], rows: [{ key: "a/vad", role: "vad", state: "ready" }, { key: "a/stt", role: "stt", state: "downloading", progress: 0.2 }] });
    await flush();
    const bar = $('#content [role=progressbar]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("60");
    expect($("#bubble")?.textContent).toContain("Mes oreilles arrivent");
    expect(byText("#content", "il me manque encore un morceau (60 %)")).toBeTruthy();
  });

  it("voix : le recommandé est coché, un extrait se lit seulement s'il existe ; « Pas de voix » est choisi", async () => {
    await press("#actions button", "Continuer");
    expect($("h1")?.textContent).toBe("Quelle voix tu me donnes ?");
    expect(all("#content .pick button.round")).toHaveLength(1);
    expect(byText("#content .pick", "Qwen3-TTS")!.textContent).toContain("Français : mal");
    expect(byText("#content .pick .chip.warn", "Français : mal")).toBeTruthy();
    // Extrait sonore : un seul son à la fois, le même bouton l'arrête.
    const played: { url: string; paused: boolean }[] = [];
    (globalThis as Any).Audio = class { url: string; paused = false; constructor(url: string) { this.url = url; played.push(this); } addEventListener() {} play() { return Promise.resolve(); } pause() { this.paused = true; } };
    const play = $("#content .pick button.round")!;
    play.click();
    await flush();
    expect(played.map((a) => a.url)).toEqual(["https://x/qwen.mp3"]);
    expect($("#content .pick button.round")!.getAttribute("aria-pressed")).toBe("true");
    $("#content .pick button.round")!.click();
    await flush();
    expect(played[0]!.paused).toBe(true);
    expect($("#content .pick button.round")!.getAttribute("aria-pressed")).toBe("false");
    await press("#content .pick", "Pas de voix");
    expect(byText("#content .pick", "Pas de voix")!.getAttribute("aria-checked")).toBe("true");
  });

  it("outils : les connecteurs réels avec leur interrupteur ; Terminer envoie la sélection à apply", async () => {
    await press("#actions button", "Continuer");
    expect($("h1")?.textContent).toBe("Quels outils tu me donnes ?");
    const sw = all("#content [role=switch]");
    expect(sw.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(byText("#content", "je te demande toujours")).toBeTruthy();
    sw[1]!.click();
    await flush();
    expect(setTool).toHaveBeenCalledWith("mail", true);
    await press("#actions button", "Terminer");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ brain: "llm/gemma", stt: "sherpa/whisper", tts: "@none" });
    expect($("h1")?.textContent).toContain("Je finis de m'installer");
  });

  it("installation : une ligne par morceau, avancement, fin", async () => {
    pushState({
      phase: "installing", live: true, notes: [],
      rows: [{ key: "a/vad", role: "vad", state: "ready" }, { key: "a/stt", role: "stt", state: "ready" }, { key: "l/prog", role: "program", state: "ready" }, { key: "l/gemma", role: "llm", state: "downloading", progress: 0.42 }],
    });
    await flush();
    expect(all("#content .line.inst")).toHaveLength(2);
    expect(byText("#content .line.inst", "Mes oreilles")!.textContent).toContain("Je t'entends");
    // Le programme prêt et le modèle à 42 % : le morceau est à 71 %.
    expect(byText("#content .line.inst", "Mon cerveau")!.textContent).toContain("71 %");
    expect($('#content [role=progressbar]')!.getAttribute("aria-valuenow")).toBe("71");
    expect($("#bubble")?.textContent).toContain("Je t'entends déjà");
    pushState({ phase: "done", notes: [{ fr: "Tout est installé.", en: "Everything is installed." }], rows: [{ key: "l/gemma", role: "llm", state: "ready" }] });
    await flush();
    expect($("h1")?.textContent).toBe("Tout est installé. Parle-moi !");
    expect(byText("#actions button", "Fermer")!.classList.contains("pri")).toBe(true);
  });
});
