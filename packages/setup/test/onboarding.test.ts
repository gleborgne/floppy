import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Onboarding, planChoices, installSteps, type Candidate, cloudBrains, offeredVoices, findAgents, withManualMemory, MIN_SPEED, type Agent,
  type OnboardingDeps, type OnboardingState, type Plan, type ChoiceRole,
} from "../src/index.ts";
import { GIB, tr, type MachineInfo, type CatalogOp, type ItemInfo, type ProviderSnapshot, type SettingInfo } from "@floppy/core";

const can = { add: false, update: false, remove: false, enable: false, child: false, test: false, action: true, search: false };
const lib = (id: string, source: string, items: ItemInfo[], missing?: string): ProviderSnapshot =>
  ({ id, section: "x", layout: "library", capabilities: [], label: id, order: 1, kinds: [], source, can, items, ...(missing ? { missing } : {}) });
const it_ = (id: string, service: string, memory: number, device: "cpu" | "gpu", extra: Partial<ItemInfo> = {}): ItemInfo =>
  ({ id, label: id, enabled: true, service, needs: { memory, device }, size: Math.round(memory * 0.8), ...extra });

/** Les bibliothèques telles que les vrais plugins les déclarent (tailles et notes de langue proches des vraies). */
function providers(opts: { llamaMissing?: boolean; whisperEn?: boolean; onlyWhisperEn?: boolean } = {}): ProviderSnapshot[] {
  const whisper = it_("whisper-en", "stt", 2.5e9, "cpu", { languages: { en: "good", fr: "poor" } });
  const parakeet = it_("parakeet", "stt", 1.3e9, "cpu", { languages: { fr: "good", en: "good" } });
  return [
    lib("sherpa-library", "sherpa", [it_("silero-vad", "vad", 50e6, "cpu"), ...(opts.onlyWhisperEn ? [whisper] : [parakeet, ...(opts.whisperEn ? [whisper] : [])])]),
    lib("local-voice-library", "tts-local", [
      it_("pocket-tts-french", "tts", 0.8 * GIB, "cpu", { languages: { fr: "good", en: "poor" } }),
      { ...it_("qwen3-tts", "tts", 4.5 * GIB, "gpu", { languages: { en: "good", fr: "fair" } }), needs: { memory: 4.5 * GIB, device: "gpu", backends: ["cuda"] } },
    ]),
    lib("llm-local-library", "llm", [it_("qwen-4b", "llm", 3.94e9, "gpu"), it_("gemma-12b", "llm", 8.18e9, "gpu"), it_("mistral-24b", "llm", 15.5e9, "gpu")],
      opts.llamaMissing ? "llama-server est introuvable" : undefined),
  ];
}

/** Valeurs de choix (`fournisseur/id`). */
const V = {
  vad: "sherpa-library/silero-vad", parakeet: "sherpa-library/parakeet", whisper: "sherpa-library/whisper-en",
  pocket: "local-voice-library/pocket-tts-french", qwen: "local-voice-library/qwen3-tts",
  q4: "llm-local-library/qwen-4b", gemma: "llm-local-library/gemma-12b", mistral: "llm-local-library/mistral-24b",
};

const machine = (m: Partial<MachineInfo>): MachineInfo => ({
  os: "windows", arch: "x64", cpu: "CPU", cores: 8, ramBytes: 32 * GIB, freeRamBytes: 16 * GIB, gpus: [],
  memory: "none", modelBytes: 0, cpuBytes: 26 * GIB, backends: [], sources: [], ...m,
});
const nvidia = machine({ memory: "dedicated", modelBytes: 18 * GIB, backends: ["cuda", "vulkan"], gpu: { name: "RTX", vendor: "nvidia", integrated: false, backends: ["cuda", "vulkan"], sources: [] } });
const mac16 = machine({ os: "mac", ramBytes: 16 * GIB, cpuBytes: 10 * GIB, memory: "unified", modelBytes: 8 * GIB, backends: ["metal"] });
const cpuOnly = machine({ ramBytes: 16 * GIB, cpuBytes: 10 * GIB });
const CLAUDE = [{ value: "claude/sonnet", label: "Claude Sonnet" }];

const choice = (p: Plan, role: ChoiceRole, value: string) => p.choices[role].find((c) => c.value === value)!;
const values = (p: Plan, role: ChoiceRole) => p.choices[role].map((c) => c.value);
/** Au plus un conseil par rôle, et il est dans la liste. */
const oneRecommendedPerRole = (p: Plan) => {
  for (const role of ["brain", "stt", "tts"] as const) {
    const rec = p.choices[role].filter((c) => c.recommended).map((c) => c.value);
    expect(rec.length).toBeLessThanOrEqual(1);
    expect(rec[0]).toBe(p.recommended[role]);
  }
};

describe("choix par rôle selon la machine", () => {
  it("sans puce graphique : le cerveau local ne tient pas, le cloud est conseillé ; écoute et voix sur le processeur", () => {
    const p = planChoices(cpuOnly, providers(), CLAUDE);
    expect(p.recommended).toEqual({ brain: "claude/sonnet", stt: V.parakeet, tts: V.pocket });
    oneRecommendedPerRole(p);
    expect(tr(choice(p, "brain", V.q4).reason!, "fr")).toBe("il faut une puce graphique");
    expect(choice(p, "brain", V.q4)).toMatchObject({ kind: "local", fits: false, recommended: false, device: "gpu" });
    expect(choice(p, "brain", "claude/sonnet")).toMatchObject({ kind: "cloud", fits: true, recommended: true, size: 0, installed: true });
    // Les choix qui tiennent d'abord, le conseil en tête ; « pas de voix » toujours là, en dernier.
    expect(values(p, "stt")).toEqual([V.parakeet]);
    expect(values(p, "tts")).toEqual([V.pocket, V.qwen, "@none"]);
    expect(choice(p, "tts", "@none")).toMatchObject({ kind: "none", fits: true, installed: true, size: 0, recommended: false });
    expect(choice(p, "tts", V.qwen).fits).toBe(false);
    // Le détecteur de parole n'est pas un choix.
    expect(values(p, "stt")).not.toContain(V.vad);
  });

  it("carte NVIDIA, 18 Go : le cerveau prend le plus grand qui tient à côté de la voix conseillée", () => {
    const p = planChoices(nvidia, providers(), CLAUDE, [], [], "fr");
    expect(p.recommended).toEqual({ brain: V.mistral, stt: V.parakeet, tts: V.pocket });
    oneRecommendedPerRole(p);
    expect(p.choices.brain.every((c) => c.fits)).toBe(true);
  });

  it("les trois conseillés tiennent ensemble : une voix sur la puce graphique laisse un cerveau plus petit", () => {
    const p = planChoices(nvidia, providers(), CLAUDE, [], [], "en");
    expect(p.recommended).toEqual({ brain: V.gemma, stt: V.parakeet, tts: V.qwen });
    const gpu = [V.qwen, V.gemma].reduce((n, v) => n + p.candidates.find((c) => `${c.provider}/${c.id}` === v)!.needs.memory, 0);
    expect(gpu).toBeLessThanOrEqual(nvidia.modelBytes);
    // Pris seul, le plus gros cerveau tiendrait : c'est bien le budget commun qui a décidé.
    expect(choice(p, "brain", V.mistral).fits).toBe(true);
  });

  it("Mac 16 Go (mémoire unifiée) : pas de voix NVIDIA ; un cerveau local trop petit laisse le cloud devant", () => {
    const p = planChoices(mac16, providers(), CLAUDE);
    expect(tr(choice(p, "tts", V.qwen).reason!, "en")).toBe("needs an NVIDIA card");
    expect(choice(p, "brain", V.q4).fits).toBe(true);
    expect(p.recommended.brain).toBe("claude/sonnet");
    // Sans cerveau cloud : le local passe devant, même petit.
    expect(planChoices(mac16, providers(), []).recommended.brain).toBe(V.q4);
  });

  it("programme manquant, disque trop petit, pas de cerveau cloud : la raison est dite, rien n'est conseillé pour le cerveau", () => {
    const p = planChoices(nvidia, providers({ llamaMissing: true }), []);
    expect(tr(choice(p, "brain", V.mistral).reason!, "fr")).toBe("llama-server est introuvable");
    expect(p.recommended.brain).toBeUndefined();
    expect(p.choices.brain.some((c) => c.recommended)).toBe(false);
    const full = planChoices({ ...nvidia, diskFreeBytes: 4 * GIB }, providers(), CLAUDE);
    expect(choice(full, "stt", V.parakeet).fits).toBe(true);
    expect(tr(choice(full, "brain", V.mistral).reason!, "en")).toMatch(/^not enough disk space/);
    expect(full.recommended.brain).toBe("claude/sonnet");
  });

  it("rien ne tient pour la voix : « pas de voix » est le conseil", () => {
    const p = planChoices(machine({ ramBytes: 2 * GIB, cpuBytes: 0.5 * GIB }), providers(), CLAUDE);
    expect(p.recommended.tts).toBe("@none");
    expect(choice(p, "tts", "@none").recommended).toBe(true);
    oneRecommendedPerRole(p);
  });

  it("modèles déjà installés : rien à télécharger", () => {
    const pv = providers();
    for (const i of pv[0]!.items) i.status = "ok";
    const p = planChoices(cpuOnly, pv, CLAUDE);
    expect(choice(p, "stt", V.parakeet)).toMatchObject({ installed: true, size: 0 });
    expect(choice(p, "tts", V.pocket)).toMatchObject({ installed: false, size: Math.round(0.8 * GIB * 0.8) });
  });

  it("mémoire choisie à la main et cerveaux cloud lus dans le slot", () => {
    expect(withManualMemory(cpuOnly, 12 * GIB)).toMatchObject({ memory: "dedicated", modelBytes: 12 * GIB });
    expect(withManualMemory(nvidia, 0)).toMatchObject({ memory: "none", modelBytes: 0 });
    const settings = [{ key: "slot.brain.main", options: [{ value: "llm/gemma", label: "Gemma" }, { value: "claude/sonnet", label: "Claude", cloud: true }] }] as unknown as SettingInfo[];
    expect(cloudBrains(settings)).toEqual([{ value: "claude/sonnet", label: "Claude" }]);
  });
});

describe("conseil selon la langue de l'assistant", () => {
  it("transcription : un modèle « poor » en français n'est pas conseillé si un « good » tient ; en anglais il l'est (plus gros)", () => {
    const pv = providers({ whisperEn: true });
    const fr = planChoices(cpuOnly, pv, CLAUDE, [], [], "fr");
    expect(fr.recommended.stt).toBe(V.parakeet);
    expect(choice(fr, "stt", V.whisper)).toMatchObject({ language: "poor", fits: true, recommended: false });
    expect(choice(fr, "stt", V.parakeet).language).toBe("good");
    const en = planChoices(cpuOnly, pv, CLAUDE, [], [], "en");
    expect(en.recommended.stt).toBe(V.whisper);
    expect(choice(en, "stt", V.whisper)).toMatchObject({ language: "good", recommended: true });
    oneRecommendedPerRole(fr);
    oneRecommendedPerRole(en);
  });

  it("un modèle « poor » reste conseillé s'il n'y a rien d'autre", () => {
    const p = planChoices(cpuOnly, providers({ onlyWhisperEn: true }), CLAUDE, [], [], "fr");
    expect(p.recommended.stt).toBe(V.whisper);
    expect(choice(p, "stt", V.whisper).language).toBe("poor");
  });

  it("une langue inconnue passe devant une mauvaise note ; la langue est lue en 2 lettres", () => {
    // Voix système (sans note) contre Pocket TTS français (« poor » en anglais) : en anglais, la voix système gagne.
    const settings = [{ key: "slot.voice.tts", options: [{ value: "tts-system/hortense", label: "Hortense" }] }] as unknown as SettingInfo[];
    const offered = offeredVoices(settings, providers());
    const en = planChoices(cpuOnly, providers(), CLAUDE, [], offered, "en-US");
    expect(en.language).toBe("en");
    expect(en.recommended.tts).toBe("tts-system/hortense");
    expect(choice(en, "tts", "tts-system/hortense")).toMatchObject({ kind: "offered", installed: true, size: 0, device: "cpu" });
    expect(choice(en, "tts", "tts-system/hortense").language).toBeUndefined();
    // En français, la voix française notée « good » gagne.
    expect(planChoices(cpuOnly, providers(), CLAUDE, [], offered, "fr").recommended.tts).toBe(V.pocket);
  });

  it("le choix donne la note pour la langue, ou rien si elle est inconnue", () => {
    const p = planChoices(nvidia, providers(), CLAUDE, [], [], "fr");
    expect(choice(p, "tts", V.qwen).language).toBe("fair");
    expect(choice(p, "tts", V.pocket).language).toBe("good");
    expect(choice(p, "brain", V.mistral).language).toBeUndefined();
    const other = planChoices(nvidia, providers(), CLAUDE, [], [], "de");
    expect(choice(other, "tts", V.pocket).language).toBeUndefined();
  });
});

/** Noyau simulé : téléchargements instantanés (un tour de boucle), slots enregistrés, vitesses données. */
function fakeKernel(m: MachineInfo, speeds: number[], agents: Agent[] = [], opts: { lang?: string; providers?: Parameters<typeof providers>[0] } = {}) {
  const snap = providers(opts.providers);
  const listeners = new Set<() => void>();
  const changes: [string, unknown][] = [];
  const ops: CatalogOp[] = [];
  const lang = { value: opts.lang ?? "fr" };
  const fire = () => { for (const fn of [...listeners]) fn(); };
  const find = (prov: string, id: string) => snap.find((s) => s.id === prov)!.items.find((i) => i.id === id)!;
  const settings = [{ key: "slot.brain.main", options: [{ value: "claude/sonnet", label: "Claude", cloud: true }] }] as unknown as SettingInfo[];
  let speedIdx = 0;
  const deps: OnboardingDeps = {
    home: mkdtempSync(join(tmpdir(), "onb-")),
    snapshot: async () => structuredClone(snap),
    run: async (op) => {
      ops.push(op);
      if (op.op === "add") {
        // Le plugin ajouté démarre et offre son cerveau (option cloud du slot).
        (settings[0]!.options as unknown[]).push({ value: "codex/gpt", label: "Codex", cloud: true });
        return { ok: true, text: "ajouté", id: "codex" };
      }
      if (op.op !== "action") return { ok: false, text: "?" };
      const item = find(op.provider, op.id);
      item.status = "loading"; item.progress = 0.5;
      setTimeout(() => { item.status = "ok"; delete item.progress; item.uses = `${op.id}-item`; fire(); }, 1);
      fire();
      return { ok: true, text: "ok" };
    },
    settings: () => settings,
    agents: () => agents,
    entries: () => [{ id: "claude", plugin: "brain-claude-cli" }],
    change: async (key, value) => { changes.push([key, value]); return { ok: true, text: "" }; },
    onItems: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    machine: async () => m,
    language: () => lang.value,
    setLanguage: async (l) => { lang.value = l; return { ok: true, text: "ok" }; },
    borrowLlm: async () => ({ service: { baseURL: "http://llm", model: "m" }, release: () => {} }),
    idle: async () => {},
    retryMs: 0,
    // 2 appels par mesure : le 1er (chargement) n'est pas compté.
    fetch: (async () => {
      const v = speeds[Math.floor(speedIdx++ / 2)] ?? 0;
      return new Response(JSON.stringify({ timings: { predicted_per_second: v } }));
    }) as unknown as typeof fetch,
  };
  return { deps, changes, ops, snap, lang };
}

const until = async (o: Onboarding, phase: OnboardingState["phase"]) => vi.waitFor(() => expect(o.state.phase).toBe(phase), { timeout: 2000 });
const idsOf = (ops: CatalogOp[]) => ops.map((x) => (x as { id: string }).id);
const brainSlot = (changes: [string, unknown][]) => changes.filter(([key]) => key === "slot.brain.main").map(([, v]) => v);
const sttSlot = (changes: [string, unknown][]) => changes.filter(([key]) => key === "slot.listen.stt").map(([, v]) => v);

describe("installation d'une sélection", () => {
  it("écoute et cerveau cloud : Floppy répond tout de suite (sans voix), puis l'écoute s'active une fois téléchargée", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    o.begin();
    expect(o.needed()).toBe(true);
    await o.plan();
    const states: OnboardingState[] = [];
    o.onState((s) => states.push(s));
    expect(o.apply({ brain: "claude/sonnet", stt: V.parakeet }).ok).toBe(true);
    await until(o, "done");
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet"]);
    // D'abord le minimum (avant tout téléchargement), puis l'écoute.
    expect(k.changes).toEqual([
      ["slot.voice.tts", "@none"],
      ["slot.brain.main", "claude/sonnet"],
      ["slot.listen.vad", "sherpa/silero-vad-item"],
      ["slot.listen.stt", "sherpa/parakeet-item"],
    ]);
    const firstLive = states.find((s) => s.live)!;
    expect(firstLive.rows.every((r) => r.state === "waiting")).toBe(true);
    expect(firstLive.selection).toEqual({ brain: "claude/sonnet", stt: V.parakeet });
    expect(tr(firstLive.notes[0]!, "fr")).toBe("Floppy répond déjà par écrit, avec Claude.");
    expect(o.state.notes.map((n) => tr(n, "fr"))).toContain("Floppy t'entend : tu peux lui parler.");
    expect(states.some((s) => s.rows.some((r) => r.state === "downloading" && r.progress === 0.5))).toBe(true);
    expect(o.state.rows.every((r) => r.state === "ready")).toBe(true);
    expect(o.needed()).toBe(false);
    expect(JSON.parse(readFileSync(join(k.deps.home, "onboarding.json"), "utf8"))).toMatchObject({ done: true, selection: { brain: "claude/sonnet", stt: V.parakeet } });
  });

  it("le conseil tel quel s'applique : voix, écoute et cerveau local, chacun avec son slot", async () => {
    const k = fakeKernel(nvidia, [40]);
    const o = new Onboarding(k.deps);
    const plan = await o.plan();
    expect(o.apply(plan.recommended).ok).toBe(true);
    await until(o, "done");
    expect(k.changes).toContainEqual(["slot.voice.tts", "tts-local/pocket-tts-french-item"]);
    expect(k.changes).toContainEqual(["slot.listen.stt", "sherpa/parakeet-item"]);
    expect(brainSlot(k.changes)).toEqual(["claude/sonnet", "llm/mistral-24b-item"]);
  });

  it("modèle sur le disque mais pas dans la liste : « use » au lieu de télécharger", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.snap[0]!.items[0]!.status = "ok"; // silero sur le disque, sans élément (pas de uses)
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: "claude/sonnet", stt: V.parakeet });
    await until(o, "done");
    expect(k.ops.map((x) => (x as { action: string }).action)).toEqual(["use", "download"]);
  });

  it("choix inconnu, ou plan pas encore lu : refusé, rien n'est lancé", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    expect(o.apply({ stt: V.parakeet }).ok).toBe(false);
    await o.plan();
    expect(o.apply({ stt: "sherpa-library/inconnu" }).ok).toBe(false);
    expect(o.apply({ brain: "nulle-part/cerveau" }).ok).toBe(false);
    expect(o.state.phase).toBe("idle");
    expect(k.ops).toEqual([]);
  });

  it("un choix qui ne tient pas reste permis (forcé)", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    const plan = await o.plan();
    expect(choice(plan, "tts", V.qwen).fits).toBe(false);
    expect(o.apply({ brain: "claude/sonnet", stt: V.parakeet, tts: V.qwen }).ok).toBe(true);
    await until(o, "done");
    expect(k.changes).toContainEqual(["slot.voice.tts", "tts-local/qwen3-tts-item"]);
  });

  it("cerveau local trop lent : le cloud répond en attendant ; Floppy prend un plus petit, le télécharge et le teste", async () => {
    const k = fakeKernel(nvidia, [MIN_SPEED - 7, 40]);
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: V.mistral, stt: V.parakeet, tts: V.pocket });
    await until(o, "done");
    // Le cerveau trop lent n'est jamais branché : le cloud, puis le plus petit.
    expect(brainSlot(k.changes)).toEqual(["claude/sonnet", "llm/gemma-12b-item"]);
    const notes = o.state.notes.map((n) => tr(n, "fr"));
    expect(notes[0]).toBe("Floppy répond déjà par écrit, avec Claude en attendant le cerveau local.");
    expect(notes).toContain("mistral-24b répondait à 8 jetons par seconde, trop lent pour parler : Floppy prend gemma-12b.");
    expect(notes).toContain("gemma-12b répond à 40 jetons par seconde : c'est lui qui répond maintenant.");
    expect(o.state.speed).toBe(40);
  });

  it("toujours trop lent, plus de petit modèle : le cerveau cloud", async () => {
    const k = fakeKernel(nvidia, [5, 5, 5]);
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: V.mistral, stt: V.parakeet });
    await until(o, "done");
    expect(brainSlot(k.changes)).toEqual(["claude/sonnet"]);
    expect(o.state.notes.map((n) => tr(n, "en"))).toContainEqual(expect.stringMatching(/too slow to talk: Floppy keeps Claude \(cloud\)\.$/));
  });

  it("échec d'un téléchargement : phase erreur, pas marqué fini ; au démarrage suivant, l'installation reprend", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.deps.run = async () => ({ ok: false, text: "réseau coupé" });
    const o = new Onboarding(k.deps);
    o.begin();
    await o.plan();
    o.apply({ brain: "claude/sonnet", stt: V.parakeet });
    await until(o, "error");
    expect(o.state.rows[0]).toMatchObject({ state: "error", text: "réseau coupé" });
    expect(o.state.live).toBe(true); // le cerveau cloud répond quand même
    expect(o.needed()).toBe(true);
    expect(JSON.parse(readFileSync(join(k.deps.home, "onboarding.json"), "utf8"))).toMatchObject({ done: false, selection: { brain: "claude/sonnet", stt: V.parakeet } });
    // Floppy relancé, le réseau revenu : la même installation reprend toute seule.
    const k2 = fakeKernel(cpuOnly, []);
    const o2 = new Onboarding({ ...k2.deps, home: k.deps.home });
    expect(await o2.resume()).toBe(true);
    await until(o2, "done");
    expect(o2.needed()).toBe(false);
    expect(await o2.resume()).toBe(false);
  });

  it("un fichier sans sélection (ancien format migré) n'est pas repris : la fenêtre revient", async () => {
    const k = fakeKernel(cpuOnly, []);
    writeFileSync(join(k.deps.home, "onboarding.json"), JSON.stringify({ done: false }));
    const o = new Onboarding(k.deps);
    expect(o.needed()).toBe(true);
    expect(await o.resume()).toBe(false);
    expect(k.ops).toEqual([]);
  });

  it("Passer : plus de fenêtre au démarrage ; une seule installation à la fois", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    o.begin();
    await o.plan();
    o.apply({ brain: "claude/sonnet", stt: V.parakeet });
    expect(o.apply({ brain: "claude/sonnet", stt: V.parakeet }).ok).toBe(false);
    await until(o, "done");
    const o2 = new Onboarding({ ...k.deps, home: mkdtempSync(join(tmpdir(), "onb-")) });
    o2.begin();
    o2.skip();
    expect(o2.needed()).toBe(false);
  });
});

describe("écoute en avance (prepareListening)", () => {
  it("télécharge le détecteur et la transcription conseillée sans attendre apply, règle leurs slots, et ne le fait qu'une fois", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    await o.prepareListening();
    await o.prepareListening();
    // Les lignes d'avancement sont dans l'état, comme les autres.
    expect(o.state.rows.map((r) => r.role)).toEqual(["vad", "stt"]);
    await vi.waitFor(() => expect(o.state.rows.every((r) => r.state === "ready")).toBe(true));
    expect(o.state.phase).toBe("idle");
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet"]);
    expect(k.changes).toEqual([["slot.listen.vad", "sherpa/silero-vad-item"], ["slot.listen.stt", "sherpa/parakeet-item"]]);
    expect(o.state.notes.map((n) => tr(n, "fr"))).toEqual(["Floppy t'entend : tu peux lui parler."]);
    await o.prepareListening();
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet"]);
  });

  it("apply avec la même transcription ne retélécharge rien et ne règle pas deux fois les slots", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    await o.prepareListening();
    await vi.waitFor(() => expect(o.state.rows.every((r) => r.state === "ready")).toBe(true));
    expect(o.apply({ brain: "claude/sonnet", stt: V.parakeet }).ok).toBe(true);
    await until(o, "done");
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet"]);
    expect(k.changes.filter(([key]) => key.startsWith("slot.listen"))).toHaveLength(2);
    expect(o.state.rows.map((r) => r.state)).toEqual(["ready", "ready"]);
    expect(o.state.notes.map((n) => tr(n, "fr")).filter((n) => n === "Floppy t'entend : tu peux lui parler.")).toHaveLength(1);
  });

  it("apply pendant le téléchargement : on attend le même téléchargement, sans le redemander", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    await o.prepareListening();
    expect(o.apply({ brain: "claude/sonnet", stt: V.parakeet }).ok).toBe(true);
    await until(o, "done");
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet"]);
    expect(sttSlot(k.changes)).toEqual(["sherpa/parakeet-item"]);
  });

  it("une autre transcription choisie ensuite prend le slot ; la première n'y touche pas", async () => {
    const k = fakeKernel(cpuOnly, [], [], { providers: { whisperEn: true }, lang: "fr" });
    const o = new Onboarding(k.deps);
    await o.prepareListening(); // conseillé en français : Parakeet
    expect(o.apply({ brain: "claude/sonnet", stt: V.whisper }).ok).toBe(true);
    await until(o, "done");
    expect(idsOf(k.ops).sort()).toEqual(["parakeet", "silero-vad", "whisper-en"]);
    expect(sttSlot(k.changes)).toEqual(["sherpa/whisper-en-item"]);
    // Le détecteur de parole, lui, est partagé : réglé une fois.
    expect(k.changes.filter(([key]) => key === "slot.listen.vad")).toHaveLength(1);
  });
});

describe("langue de l'assistant", () => {
  it("la changer passe par la même voie que les Réglages, puis recalcule le conseil", async () => {
    const k = fakeKernel(nvidia, [], [], { lang: "fr" });
    const o = new Onboarding(k.deps);
    const fr = await o.plan();
    expect(fr.language).toBe("fr");
    expect(fr.recommended.tts).toBe(V.pocket);
    const r = await o.setLanguage("en");
    expect(r.ok).toBe(true);
    expect(k.lang.value).toBe("en");
    expect(r.plan!.language).toBe("en");
    expect(r.plan!.recommended.tts).toBe(V.qwen);
    // Le plan recalculé est celui qu'`apply` utilise.
    expect(o.apply({ tts: V.qwen }).ok).toBe(true);
  });

  it("un changement refusé laisse le plan tel quel", async () => {
    const k = fakeKernel(nvidia, []);
    k.deps.setLanguage = async () => ({ ok: false, text: "non" });
    const o = new Onboarding(k.deps);
    await o.plan();
    expect(await o.setLanguage("en")).toEqual({ ok: false, text: "non" });
  });
});

describe("Claude Code, Codex, Antigravity", () => {
  const manifests = [
    { id: "brain-claude-cli", addable: { section: "brain", label: "Claude Code", program: "claude" } },
    { id: "brain-codex-cli", addable: { section: "brain", label: "Codex", program: "codex" } },
    { id: "brain-agy-cli", addable: { section: "brain", label: "Antigravity", program: "agy" } },
    { id: "browser", addable: { section: "connectors", label: "Navigateur" } },
  ];
  const entries = [{ id: "claude", plugin: "brain-claude-cli" }, { id: "claude/llm/sonnet", plugin: "brain-claude-cli", fork: {} }];
  const settings = [{ key: "slot.brain.main", options: [{ value: "claude/sonnet", label: "Claude", cloud: true }] }] as unknown as SettingInfo[];

  it("cherche le programme de chaque plugin qui en déclare un ; dit s'il est déjà dans la config", () => {
    const a = findAgents(manifests, entries, (p) => (p === "codex" ? "/bin/codex" : undefined));
    expect(a.map((x) => [x.plugin, x.found, x.entries])).toEqual([
      ["brain-claude-cli", false, ["claude"]],
      ["brain-codex-cli", true, []],
      ["brain-agy-cli", false, []],
    ]);
  });

  it("Claude Code absent, Codex trouvé : le cerveau conseillé est Codex, à ajouter ; Claude est grisé", () => {
    const a = findAgents(manifests, entries, (p) => (p === "codex" ? "/bin/codex" : undefined));
    const clouds = cloudBrains(settings, a, entries);
    expect(clouds).toEqual([{ value: "claude/sonnet", label: "Claude", plugin: "brain-claude-cli", found: false }]);
    const p = planChoices(cpuOnly, providers(), clouds, a);
    expect(p.brain).toBe("add:brain-codex-cli");
    expect(p.recommended.brain).toBe("add:brain-codex-cli");
    expect(choice(p, "brain", "add:brain-codex-cli")).toMatchObject({ kind: "cloud", fits: true, installed: false, recommended: true });
    expect(choice(p, "brain", "claude/sonnet")).toMatchObject({ fits: false });
    expect(tr(choice(p, "brain", "claude/sonnet").reason!, "fr")).toBe("claude est introuvable");
    expect(values(p, "brain")).not.toContain("add:brain-agy-cli");
  });

  it("aucun programme trouvé et rien d'autre : pas de cerveau conseillé, et pas de cerveau cloud à choisir qui marche", () => {
    const a = findAgents(manifests, entries, () => undefined);
    const p = planChoices(cpuOnly, providers(), cloudBrains(settings, a, entries), a);
    expect(p.brain).toBeUndefined();
    expect(p.recommended.brain).toBeUndefined();
    expect(p.choices.brain.filter((c) => c.kind === "cloud").every((c) => !c.fits)).toBe(true);
  });

  it("installer avec « add:… » ajoute le plugin, puis prend son cerveau", async () => {
    const agents = findAgents(manifests, entries, (p) => (p === "codex" ? "/bin/codex" : undefined));
    const k = fakeKernel(cpuOnly, [], agents);
    const o = new Onboarding(k.deps);
    const plan = await o.plan();
    expect(plan.brain).toBe("add:brain-codex-cli");
    o.apply({ brain: plan.recommended.brain!, stt: V.parakeet });
    await until(o, "done");
    expect(k.ops.find((x) => x.op === "add")).toEqual({ op: "add", provider: "apps-brain", kind: "brain-codex-cli", values: {} });
    expect(k.changes).toContainEqual(["slot.brain.main", "codex/gpt"]);
    expect(tr(o.state.notes[0]!, "fr")).toBe("Codex est ajouté.");
  });
});

describe("voix déjà offertes (voix du système)", () => {
  const settings = [{ key: "slot.voice.tts", options: [
    { value: "@none", label: "Aucune" },
    { value: "tts-system/hortense", label: "Hortense" },
    { value: "tts-gemini/kore", label: "Kore", cloud: true },
    { value: "tts-local/anna", label: "Anna" },
  ] }] as unknown as SettingInfo[];

  it("hors cloud et hors plugin sans programme ; une voix à télécharger qui tient passe devant", () => {
    const pv = providers();
    pv[1]!.missing = "audio.cpp introuvable";
    const offered = offeredVoices(settings, pv);
    expect(offered.map((c) => `${c.source}/${c.uses}`)).toEqual(["tts-system/hortense", "tts-local/anna"].filter((v) => !v.startsWith("tts-local")));
    const p = planChoices(cpuOnly, pv, CLAUDE, [], offered);
    expect(p.recommended.tts).toBe("tts-system/hortense");
    expect(tr(choice(p, "tts", V.pocket).reason!, "fr")).toBe("audio.cpp introuvable");
    expect(choice(p, "tts", "tts-system/hortense")).toMatchObject({ kind: "offered", fits: true, size: 0 });
    // audio.cpp présent : Pocket TTS (bibliothèque) gagne en français, la voix système reste un choix.
    const pz = planChoices(cpuOnly, providers(), CLAUDE, [], offeredVoices(settings, providers()));
    expect(pz.recommended.tts).toBe(V.pocket);
    expect(values(pz, "tts")).toContain("tts-system/hortense");
  });

  it("installation : la voix offerte est prête tout de suite et réglée dans le slot", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.snap[1]!.missing = "audio.cpp introuvable";
    const base = k.deps.settings;
    k.deps.settings = () => [...base(), ...settings];
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: "claude/sonnet", stt: V.parakeet, tts: "tts-system/hortense" });
    await until(o, "done");
    expect(k.changes).toContainEqual(["slot.voice.tts", "tts-system/hortense"]);
    expect(k.changes).not.toContainEqual(["slot.voice.tts", "@none"]);
  });
});

describe("programmes à installer (llama.cpp, audio.cpp)", () => {
  /** Bibliothèques dont le programme manque, avec leurs versions à télécharger (GPU et processeur). */
  function withPrograms(): ProviderSnapshot[] {
    const pv = providers();
    pv[1]!.missing = "audio.cpp n'est pas installé";
    pv[2]!.missing = "llama.cpp n'est pas installé";
    const prog = (id: string, backend: string, size: number): ItemInfo => ({ id, label: id, enabled: true, service: "program", backend, size });
    pv.push(lib("local-voice-program", "tts-local", [prog("audio-cuda", "cuda", 850e6), prog("audio-cpu", "cpu", 32e6)]));
    pv.push(lib("llm-local-program", "llm", [prog("llama-cuda", "cuda", 600e6), prog("llama-cpu", "cpu", 25e6)]));
    return pv;
  }

  it("un programme manquant mais téléchargeable ne bloque plus : sa taille s'ajoute à celle du modèle", () => {
    const p = planChoices(nvidia, withPrograms(), CLAUDE);
    expect(p.choices.tts.concat(p.choices.brain).every((c) => c.fits)).toBe(true);
    // Voix sur le processeur : la petite version d'audio.cpp suffit ; sur la puce graphique : la version CUDA.
    expect(choice(p, "tts", V.pocket).size).toBe(Math.round(0.8 * GIB * 0.8) + 32e6);
    expect(choice(p, "tts", V.qwen).size).toBe(Math.round(4.5 * GIB * 0.8) + 850e6);
    expect(choice(p, "brain", V.mistral).size).toBe(Math.round(15.5e9 * 0.8) + 600e6);
  });

  it("programme déjà installé en version processeur : une voix de la puce graphique demande la mise à jour (sa taille)", () => {
    const pv = withPrograms();
    pv[1]!.missing = undefined;
    pv[3]!.items[1]!.status = "ok"; // audio-cpu installé
    const p = planChoices(nvidia, pv, CLAUDE);
    expect(choice(p, "tts", V.pocket).size).toBe(Math.round(0.8 * GIB * 0.8));
    expect(choice(p, "tts", V.qwen).size).toBe(Math.round(4.5 * GIB * 0.8) + 850e6);
  });

  it("installation : le programme est prêt quand il est installé, sans slot à régler", async () => {
    const k = fakeKernel(nvidia, [40]);
    k.snap.splice(0, k.snap.length, ...withPrograms());
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: V.mistral, stt: V.parakeet, tts: V.pocket });
    await until(o, "done");
    // L'écoute d'abord, puis la voix (avec son programme), puis le cerveau (avec le sien).
    expect(idsOf(k.ops)).toEqual(["silero-vad", "parakeet", "audio-cpu", "pocket-tts-french", "llama-cuda", "mistral-24b"]);
    expect(k.changes.map(([key]) => key)).not.toContain("slot.program");
    expect(o.state.rows.find((r) => r.role === "program")?.state).toBe("ready");
  });
});

describe("ordre d'installation", () => {
  const c = (id: string, role: Candidate["role"], source: string): Candidate =>
    ({ provider: `${source}-lib`, source, id, label: id, role, needs: { memory: 0, device: "cpu" }, installed: false, size: 1 });
  const picks = [c("prog-voix", "program", "tts"), c("prog-llm", "program", "llm"), c("vad", "vad", "sherpa"), c("stt", "stt", "sherpa"), c("voix", "tts", "tts"), c("llm", "llm", "llm")];
  const ids2 = (steps: Candidate[][]) => steps.map((s) => s.map((p) => p.id));

  it("l'écoute d'abord ; avec un cerveau qui répond déjà : la voix, puis le cerveau local", () => {
    expect(ids2(installSteps(picks, true))).toEqual([["vad", "stt"], ["prog-voix", "voix"], ["prog-llm", "llm"]]);
  });

  it("sans cerveau qui répond : le cerveau passe avant la voix", () => {
    expect(ids2(installSteps(picks, false))).toEqual([["vad", "stt"], ["prog-llm", "llm"], ["prog-voix", "voix"]]);
  });
});

describe("modèles déjà sur la machine (LM Studio, Ollama)", () => {
  const FOUND = "llm-local-found/ollama-qwen3-8b";
  const withFound = (memory: number): ProviderSnapshot[] => [
    ...providers(),
    lib("llm-local-found", "llm", [{ ...it_("ollama-qwen3-8b", "llm", memory, "gpu"), size: 0, status: "ok" }]),
  ];

  it("un modèle trouvé assez grand passe devant un plus grand à télécharger : rien à télécharger pour le cerveau", () => {
    const p = planChoices(nvidia, withFound(7e9), CLAUDE);
    expect(p.recommended.brain).toBe(FOUND);
    expect(choice(p, "brain", FOUND)).toMatchObject({ installed: true, size: 0, kind: "local" });
  });

  it("trop petit pour bien parler : le catalogue garde la main", () => {
    expect(planChoices(nvidia, withFound(3e9), CLAUDE).recommended.brain).toBe(V.mistral);
  });

  it("installation : « use » l'ajoute à la liste ; s'il ne répond pas au test, le cerveau cloud reste", async () => {
    const k = fakeKernel(nvidia, []);
    k.snap.push(withFound(7e9).at(-1)!);
    k.deps.fetch = (async () => new Response("erreur", { status: 500 })) as unknown as typeof fetch;
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply({ brain: FOUND, stt: V.parakeet });
    await until(o, "done");
    expect(k.ops).toContainEqual({ op: "action", provider: "llm-local-found", id: "ollama-qwen3-8b", action: "use" });
    expect(brainSlot(k.changes)).toEqual(["claude/sonnet"]);
    expect(o.state.notes.map((n) => tr(n, "fr"))).toContainEqual(expect.stringMatching(/^ollama-qwen3-8b n'a pas répondu au test : Floppy garde le cerveau du cloud/));
  });
});
