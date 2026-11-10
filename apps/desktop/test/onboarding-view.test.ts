import { describe, it, expect } from "vitest";
import {
  gb, needsManual, stepAt, questionNumber, machineRows, rowStatus, installSummary, tr, mergeSelection, startTab, brainsOf, hasReadyCloud, tabOf,
  sizeText, alreadyHere, languageTag, machineVerdict, selectionToApply, keysText, waysSummary, micLevel, barLevels, groupRows, earsReady, percent, STEPS,
} from "../src/renderer/onboarding-view.ts";
import { pieceItems, bubbleKey } from "../src/renderer/onboarding-summary.ts";
import { makeT, TABLES } from "../src/renderer/onboarding-i18n.ts";

const GIB = 1024 ** 3;
const t = (k: string, v?: Record<string, string | number>) => `<${k}${v ? JSON.stringify(v) : ""}>`;

const choice = (value: string, over: Partial<OnboardingChoice> = {}): OnboardingChoice => ({
  value, kind: "local", fits: true, installed: false, size: 0, recommended: false, label: value, ...over,
});
const plan = (over: Partial<OnboardingPlan> = {}): OnboardingPlan => ({
  machine: { sources: ["x"] }, language: "fr", cloudBrains: [],
  choices: {
    brain: [choice("llm/gemma", { recommended: true, size: 9 * GIB }), choice("llm/qwen", { size: 3 * GIB }), choice("claude/opus", { kind: "cloud" }), choice("add:codex", { kind: "cloud", installed: false })],
    stt: [choice("sherpa/parakeet", { recommended: true, size: 600e6 }), choice("sherpa/whisper")],
    tts: [choice("audiocpp/qwen3", { recommended: true, size: 2 * GIB, sample: "https://x/qwen.mp3" }), choice("@none", { kind: "none", installed: true })],
  },
  recommended: { brain: "llm/gemma", stt: "sherpa/parakeet", tts: "audiocpp/qwen3" }, ...over,
});

describe("fenêtre Bienvenue : textes", () => {
  it("tailles en Go, arrondies à 0,5, dans les deux langues", () => {
    expect(gb(9.4 * GIB, "fr")).toBe("9,5 Go");
    expect(gb(9.4 * GIB, "en")).toBe("9.5 GB");
    expect(gb(16 * GIB, "fr")).toBe("16 Go");
  });

  it("chaque texte existe en français et en anglais, avec les mêmes variables", () => {
    for (const key of Object.keys(TABLES.fr) as (keyof typeof TABLES.fr)[]) {
      expect(TABLES.en[key], key).toBeTruthy();
      expect(TABLES.en[key].match(/\{\w+\}/g)?.sort(), key).toEqual(TABLES.fr[key].match(/\{\w+\}/g)?.sort());
    }
    expect(makeT("en")("questionOf", { n: 2 })).toBe("Question 2 of 4");
    expect(makeT("fr")("questionOf", { n: 2 })).toBe("Question 2 sur 4");
    expect(makeT("fr")("inconnu")).toBe("inconnu");
  });

  it("aucun texte ne nomme un système d'exploitation", () => {
    for (const lang of ["fr", "en"] as const) for (const s of Object.values(TABLES[lang])) expect(s).not.toMatch(/windows|macos|linux|cmd |option /i);
  });

  it("raccourci écrit Ctrl+Alt+…, en ⌃⌥ sur Mac", () => {
    expect(keysText("Ctrl+Alt+F", false)).toBe("Ctrl+Alt+F");
    expect(keysText("Ctrl+Alt+F", true)).toBe("⌃⌥F");
  });
});

describe("fenêtre Bienvenue : étapes et choix", () => {
  it("bonjour, quatre questions, installation", () => {
    expect(STEPS).toEqual(["hello", "brain", "ears", "voice", "tools", "install"]);
    expect(stepAt("hello", 1)).toBe("brain");
    expect(stepAt("tools", 1)).toBe("install");
    expect(stepAt("hello", -1)).toBe("hello");
    expect(stepAt("install", 1)).toBe("install");
    expect(["hello", "brain", "ears", "voice", "tools", "install"].map((s) => questionNumber(s as never))).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it("présélection : le conseil du plan ; un choix de l'utilisateur est gardé s'il existe encore", () => {
    const p = plan();
    expect(mergeSelection(p, {}, new Set())).toEqual(p.recommended);
    expect(mergeSelection(p, { tts: "@none", brain: "llm/qwen" }, new Set(["tts"]))).toEqual({ ...p.recommended, tts: "@none" });
    // Le choix n'est plus dans le plan (langue changée) : le conseil reprend.
    expect(mergeSelection(p, { stt: "sherpa/disparu" }, new Set(["stt"]))).toEqual(p.recommended);
    // Pas de cerveau possible : rien n'est choisi pour lui.
    expect(mergeSelection(plan({ recommended: { tts: "@none" } }), {}, new Set())).toEqual({ tts: "@none" });
  });

  it("onglet de départ du cerveau : celui du conseil", () => {
    expect(startTab(plan(), { brain: "llm/gemma" })).toBe("local");
    expect(startTab(plan(), { brain: "claude/opus" })).toBe("cloud");
    expect(startTab(plan(), {})).toBe("local");
    expect(tabOf(plan(), "add:codex")).toBe("cloud");
    expect(tabOf(plan(), "nul")).toBeUndefined();
  });

  it("« Chez toi » = modèles locaux, « En ligne » = cerveaux cloud ; un cerveau en ligne est prêt s'il tient", () => {
    const p = plan();
    expect(brainsOf(p, "local").map((c) => c.value)).toEqual(["llm/gemma", "llm/qwen"]);
    expect(brainsOf(p, "cloud").map((c) => c.value)).toEqual(["claude/opus", "add:codex"]);
    expect(hasReadyCloud(p)).toBe(true);
    const none = plan(); none.choices.brain = none.choices.brain.map((c) => (c.kind === "cloud" ? { ...c, fits: false } : c));
    expect(hasReadyCloud(none)).toBe(false);
    expect(hasReadyCloud(plan({ choices: { ...p.choices, brain: [choice("llm/gemma")] } }))).toBe(false);
  });

  it("taille à télécharger, ou « déjà sur ton ordinateur »", () => {
    expect(sizeText(choice("a", { size: 9 * GIB }), t, "fr")).toBe("<toDownload>9 Go");
    expect(sizeText(choice("a", { installed: true }), t, "fr")).toBe("");
    expect(sizeText(choice("a", { kind: "cloud", size: 5 * GIB }), t, "fr")).toBe("");
    expect(alreadyHere(choice("a", { installed: true }))).toBe(true);
    expect(alreadyHere(choice("a", { installed: true, size: 1 }))).toBe(false); // le programme reste à installer
    expect(alreadyHere(choice("a", { kind: "offered", installed: true }))).toBe(true);
    expect(alreadyHere(choice("a", { kind: "cloud", installed: true }))).toBe(false);
    expect(alreadyHere(choice("@none", { kind: "none", installed: true }))).toBe(false);
  });

  it("étiquette de langue : jaune si mal gérée, absente si inconnue", () => {
    const p = plan();
    expect(languageTag(choice("a", { language: "poor" }), p, "fr")).toMatchObject({ text: "Français : mal", tone: "warn" });
    expect(languageTag(choice("a", { language: "good" }), p, "en")).toMatchObject({ text: "French: good", tone: "plain" });
    expect(languageTag(choice("a"), p, "fr")).toBeNull();
  });

  it("la sélection envoyée à apply ne garde que les rôles choisis", () => {
    expect(selectionToApply({ brain: "a", tts: "@none" })).toEqual({ brain: "a", tts: "@none" });
    expect(selectionToApply({})).toEqual({});
  });
});

describe("fenêtre Bienvenue : bonjour", () => {
  it("la machine en une phrase", () => {
    expect(machineVerdict(plan())).toBe("full");
    expect(machineVerdict(plan({ recommended: { brain: "claude/opus", tts: "@none" } }))).toBe("cloud");
    expect(machineVerdict(plan({ recommended: { tts: "@none" } }))).toBe("tight");
    expect(machineVerdict(plan({ machine: { sources: [] } }))).toBe("unread");
  });

  it("choix à la main seulement si rien n'a été lu", () => {
    expect(needsManual({ machine: { sources: [] } } as never)).toBe(true);
    expect(needsManual({ machine: { sources: ["sysctl"] } } as never)).toBe(false);
  });

  it("résumé de la machine : puce, mémoire, RAM, disque", () => {
    const m = { gpu: { name: "Apple M4" }, memory: "unified", modelBytes: 8 * GIB, ramBytes: 16 * GIB, diskFreeBytes: 100 * GIB };
    expect(machineRows(m, t, "fr")).toEqual([["<chip>", "Apple M4"], ["<memoryKind>", "<unified>"], ["<forModels>", "8 Go"], ["<ram>", "16 Go"], ["<disk>", "100 Go"]]);
    expect(machineRows({ ramBytes: 8 * GIB }, t, "en")).toEqual([["<chip>", "<noChip>"], ["<ram>", "8 GB"]]);
  });
});

describe("fenêtre Bienvenue : oreilles", () => {
  it("ce qui est allumé parmi les façons d'appeler Floppy", () => {
    const on = { wake: { on: true, value: "w/a", fallback: "w/a" }, talk: { keys: "Ctrl+Alt+F", fallback: "Ctrl+Alt+F" } };
    expect(waysSummary(on, t)).toBe("<waysBoth>");
    expect(waysSummary({ ...on, talk: { keys: "", fallback: "Ctrl+Alt+F" } }, t)).toBe("<waysWake>");
    expect(waysSummary({ wake: null, talk: on.talk }, t)).toBe("<waysKeys>");
    expect(waysSummary(null, t)).toBe("<waysNone>");
  });

  it("niveau du micro : silence = 0, voix forte = proche de 1, borné", () => {
    expect(micLevel(new Uint8Array(256).fill(128))).toBe(0);
    expect(micLevel([])).toBe(0);
    const loud = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 228 : 28));
    expect(micLevel(loud)).toBe(1);
    const soft = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 138 : 118));
    expect(micLevel(soft)).toBeGreaterThan(0.1);
    expect(micLevel(soft)).toBeLessThan(0.5);
  });

  it("barres du micro : toujours visibles, plus hautes au milieu", () => {
    const calm = barLevels(0, 12);
    expect(calm).toHaveLength(12);
    expect(Math.min(...calm)).toBeGreaterThan(0);
    const loud = barLevels(1, 12);
    expect(Math.max(...loud)).toBeLessThanOrEqual(1);
    expect(loud[6]!).toBeGreaterThan(loud[0]!);
  });
});

describe("fenêtre Bienvenue : installation", () => {
  const row = (key: string, role: string, state: string, progress?: number, text?: AppText): OnboardingRow => ({ key, role, state, ...(progress !== undefined ? { progress } : {}), ...(text ? { text } : {}) });

  it("regroupe les lignes par morceau : oreilles (détecteur, transcription, leur programme), voix, cerveau", () => {
    const rows = [
      row("audio/prog", "program", "ready"), row("audio/vad", "vad", "ready"), row("audio/stt", "stt", "downloading", 0.5),
      row("tts/prog", "program", "ready"), row("tts/voice", "tts", "waiting"),
      row("llama/prog", "program", "waiting"), row("llama/gemma", "llm", "waiting"),
    ];
    const g = groupRows(rows);
    expect(g.map((x) => x.key)).toEqual(["ears", "voice", "brain"]);
    expect(g[0]!.rows.map((r) => r.key)).toEqual(["audio/prog", "audio/vad", "audio/stt"]);
    expect(g[1]!.rows.map((r) => r.key)).toEqual(["tts/prog", "tts/voice"]);
    expect(g[2]!.rows.map((r) => r.key)).toEqual(["llama/prog", "llama/gemma"]);
    // Un programme déjà prêt compte comme un début d'avancement ; rien de prêt ni en route : en attente.
    expect(g.map((x) => x.state)).toEqual(["downloading", "downloading", "waiting"]);
    expect(g[0]!.progress).toBeCloseTo((1 + 1 + 0.5) / 3);
  });

  it("un groupe est prêt quand toutes ses lignes le sont, en erreur dès qu'une l'est (avec son texte)", () => {
    expect(groupRows([row("a/vad", "vad", "ready"), row("a/stt", "stt", "ready")])[0]!.state).toBe("ready");
    const bad = groupRows([row("a/vad", "vad", "ready"), row("a/stt", "stt", "error", undefined, { fr: "réseau", en: "network" })])[0]!;
    expect(bad.state).toBe("error");
    expect(tr(bad.error, "en")).toBe("network");
    expect(groupRows([])).toEqual([]);
  });

  it("le petit modèle pris après un test trop lent reste dans le cerveau", () => {
    const g = groupRows([row("llama/prog", "program", "ready"), row("llama/big", "llm", "ready"), row("llama/small", "llm", "downloading", 0.2)]);
    expect(g).toHaveLength(1);
    expect(g[0]!.key).toBe("brain");
    expect(g[0]!.rows).toHaveLength(3);
  });

  it("l'écoute est prête quand ses lignes le sont ; avancement en pourcentage", () => {
    expect(earsReady({ phase: "installing", rows: [row("a/vad", "vad", "ready"), row("a/stt", "stt", "ready")], notes: [] })).toBe(true);
    expect(earsReady({ phase: "installing", rows: [row("a/vad", "vad", "ready"), row("a/stt", "stt", "waiting")], notes: [] })).toBe(false);
    expect(earsReady(null)).toBe(false);
    expect(percent(0.426, "fr")).toBe("42 %");
    expect(percent(0.426, "en")).toBe("42%");
    expect(percent(3, "en")).toBe("100%");
  });

  it("état d'une ligne d'installation", () => {
    expect(rowStatus({ state: "downloading", progress: 0.42, role: "stt" }, t, "fr")).toBe("42 %");
    expect(rowStatus({ state: "downloading", progress: 0.42, role: "stt" }, t, "en")).toBe("42%");
    expect(rowStatus({ state: "error", text: { fr: "réseau", en: "network" }, role: "stt" }, t, "en")).toBe("network");
    expect(rowStatus({ state: "ready", role: "stt" }, t, "fr")).toBe("<ready>");
  });
});

describe("fenêtre Bienvenue : colonne de gauche", () => {
  const input = (step: never, over: object = {}) => ({ step, plan: plan(), sel: plan().recommended, extras: null, inst: null, lang: "fr", t, ...over });

  it("les morceaux se cochent au fil des questions, avec la valeur choisie", () => {
    const items = pieceItems(input("voice" as never, {
      sel: { brain: "claude/opus", stt: "sherpa/parakeet", tts: "@none" },
      extras: { ways: { wake: { on: true, value: "w", fallback: "w" }, talk: null }, tools: { provider: "p", items: [] } },
    }));
    expect(items.map((i) => i.state)).toEqual(["done", "done", "current", "todo"]);
    expect(items[0]!.detail).toBe("claude/opus, <online>");
    expect(items[1]!.detail).toBe("<waysWake>");
    expect(items[2]!.detail).toBe('<questionOf{"n":3}>');
    expect(items[3]!.detail).toBe("<tools.sub>");
  });

  it("bonjour : rien n'est fait ; installation : tout est fait, outils allumés compris", () => {
    expect(pieceItems(input("hello" as never)).every((i) => i.state === "todo")).toBe(true);
    const done = pieceItems(input("install" as never, { extras: { ways: { wake: null, talk: null }, tools: { provider: "p", items: [{ id: "a", label: "Web", enabled: true, toggleable: true }, { id: "b", label: "Mail", enabled: false, toggleable: true }] } } }));
    expect(done.every((i) => i.state === "done")).toBe(true);
    expect(done[0]!.detail).toBe("llm/gemma, <atHome>");
    expect(done[2]!.detail).toBe("audiocpp/qwen3");
    expect(done[3]!.detail).toBe("Web");
    expect(pieceItems(input("install" as never, { sel: { tts: "@none" }, extras: null }))[2]!.detail).toBe("<noVoice>");
  });

  it("la bulle suit l'écran : oreilles pas encore téléchargées, voix avec ou sans extraits, fin", () => {
    const wait: OnboardingState = { phase: "idle", rows: [{ key: "a/stt", role: "stt", state: "downloading", progress: 0.6 }], notes: [] };
    const ready: OnboardingState = { phase: "installing", rows: [{ key: "a/stt", role: "stt", state: "ready" }], notes: [] };
    expect(bubbleKey("hello", plan(), null)).toBe("bubble.hello");
    expect(bubbleKey("ears", plan(), null)).toBe("bubble.ears");
    expect(bubbleKey("ears", plan(), wait)).toBe("bubble.earsWait");
    expect(bubbleKey("voice", plan(), null)).toBe("bubble.voice");
    const plain = plan(); plain.choices.tts = [choice("@none", { kind: "none" })];
    expect(bubbleKey("voice", plain, null)).toBe("bubble.voicePlain");
    expect(bubbleKey("install", plan(), ready)).toBe("bubble.installEars");
    expect(bubbleKey("install", plan(), { ...ready, phase: "done" })).toBe("bubble.done");
    expect(bubbleKey("install", plan(), { ...ready, phase: "error" })).toBe("bubble.error");
    expect(bubbleKey("install", plan(), null)).toBe("bubble.install");
  });
});

describe("installation de départ dans les réglages", () => {
  const rows = [{ state: "ready" }, { state: "downloading", progress: 0.4 }, { state: "waiting" }].map((r) => ({ ...r, role: "stt" }));
  it("rien à montrer avant une installation", () => {
    expect(installSummary(null)).toBeNull();
    expect(installSummary({ phase: "idle", rows: [], notes: [] })).toBeNull();
  });
  it("en cours, terminée, ou un morceau a échoué : morceaux prêts sur le total", () => {
    expect(installSummary({ phase: "installing", rows, notes: [] })).toEqual({ running: true, ready: 1, total: 3, failed: false });
    expect(installSummary({ phase: "testing", rows, notes: [] })?.running).toBe(true);
    expect(installSummary({ phase: "error", rows, notes: [] })).toMatchObject({ running: false, failed: true });
  });
});
