import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Onboarding, planLevels, installSteps, type Candidate, cloudBrains, offeredVoices, findAgents, withManualMemory, MIN_SPEED, type Agent,
  type OnboardingDeps, type OnboardingState,
} from "../src/onboarding.ts";
import { GIB, type MachineInfo } from "../src/machine.ts";
import type { CatalogOp, ItemInfo, ProviderSnapshot } from "../src/catalog.ts";
import type { SettingInfo } from "../src/settings.ts";
import { tr } from "../src/i18n.ts";

const can = { add: false, update: false, remove: false, enable: false, child: false, test: false, action: true, search: false };
const lib = (id: string, source: string, items: ItemInfo[], missing?: string): ProviderSnapshot =>
  ({ id, section: "x", layout: "library", capabilities: [], label: id, order: 1, kinds: [], source, can, items, ...(missing ? { missing } : {}) });
const it_ = (id: string, service: string, memory: number, device: "cpu" | "gpu", extra: Partial<ItemInfo> = {}): ItemInfo =>
  ({ id, label: id, enabled: true, service, needs: { memory, device }, size: Math.round(memory * 0.8), ...extra });

/** Les bibliothèques telles que les vrais plugins les déclarent (tailles proches des vraies). */
function providers(opts: { llamaMissing?: boolean } = {}): ProviderSnapshot[] {
  return [
    lib("sherpa-library", "sherpa", [it_("silero-vad", "vad", 50e6, "cpu"), it_("parakeet", "stt", 1.3e9, "cpu")]),
    lib("voix-locale-library", "tts-local", [
      it_("pocket-tts-french", "tts", 0.8 * GIB, "cpu"),
      { ...it_("qwen3-tts", "tts", 4.5 * GIB, "gpu"), needs: { memory: 4.5 * GIB, device: "gpu", backends: ["cuda"] } },
    ]),
    lib("llm-local-library", "llm", [it_("qwen-4b", "llm", 3.94e9, "gpu"), it_("gemma-12b", "llm", 8.18e9, "gpu"), it_("mistral-24b", "llm", 15.5e9, "gpu")],
      opts.llamaMissing ? "llama-server est introuvable" : undefined),
  ];
}

const machine = (m: Partial<MachineInfo>): MachineInfo => ({
  os: "windows", arch: "x64", cpu: "CPU", cores: 8, ramBytes: 32 * GIB, freeRamBytes: 16 * GIB, gpus: [],
  memory: "none", modelBytes: 0, cpuBytes: 26 * GIB, backends: [], sources: [], ...m,
});
const nvidia = machine({ memory: "dedicated", modelBytes: 18 * GIB, backends: ["cuda", "vulkan"], gpu: { name: "RTX", vendor: "nvidia", integrated: false, backends: ["cuda", "vulkan"], sources: [] } });
const mac16 = machine({ os: "mac", ramBytes: 16 * GIB, cpuBytes: 10 * GIB, memory: "unified", modelBytes: 8 * GIB, backends: ["metal"] });
const cpuOnly = machine({ ramBytes: 16 * GIB, cpuBytes: 10 * GIB });
const CLAUDE = [{ value: "claude/sonnet", label: "Claude Sonnet" }];

const lvl = (p: ReturnType<typeof planLevels>, id: string) => p.levels.find((l) => l.id === id)!;
const ids = (p: ReturnType<typeof planLevels>, id: string) => lvl(p, id).picks.map((x) => x.id);

describe("niveaux selon la machine", () => {
  it("sans puce graphique : texte et voix légère ; conseil : voix légère", () => {
    const p = planLevels(cpuOnly, providers(), CLAUDE);
    expect(p.levels.filter((l) => l.possible).map((l) => l.id)).toEqual(["texte", "voix"]);
    expect(ids(p, "texte")).toEqual(["silero-vad", "parakeet"]);
    expect(ids(p, "voix")).toEqual(["silero-vad", "parakeet", "pocket-tts-french"]);
    expect(tr(lvl(p, "local").reason!, "fr")).toBe("cerveau : il faut une puce graphique");
    expect(p.recommended).toBe("voix");
  });

  it("carte NVIDIA avec 18 Go pour les modèles : tout est possible ; le cerveau prend le plus grand qui tient à côté de la voix", () => {
    const p = planLevels(nvidia, providers(), CLAUDE);
    expect(p.levels.every((l) => l.possible)).toBe(true);
    expect(ids(p, "local")).toContain("mistral-24b");
    expect(ids(p, "local-max")).toEqual(["silero-vad", "parakeet", "qwen3-tts", "gemma-12b"]);
    expect(p.recommended).toBe("local-max");
  });

  it("Mac 16 Go : pas de voix NVIDIA ; un cerveau local trop petit laisse le cloud devant", () => {
    const p = planLevels(mac16, providers(), CLAUDE);
    expect(tr(lvl(p, "hybride").reason!, "fr")).toBe("voix : demande une carte NVIDIA");
    // Mémoire unifiée : les modèles processeur (2,2 Go) sortent du même budget.
    expect(ids(p, "local")).toContain("qwen-4b");
    expect(p.recommended).toBe("voix");
    // Sans cerveau cloud : le local passe devant.
    expect(planLevels(mac16, providers(), []).recommended).toBe("local");
  });

  it("programme manquant, disque trop petit, pas de cerveau cloud : la raison est dite", () => {
    const p = planLevels(nvidia, providers({ llamaMissing: true }), []);
    expect(tr(lvl(p, "local").reason!, "fr")).toBe("cerveau : llama-server est introuvable");
    expect(tr(lvl(p, "texte").reason!, "fr")).toMatch(/aucun cerveau dans le cloud/);
    expect(p.levels.some((l) => l.possible)).toBe(false);
    const full = planLevels({ ...nvidia, diskFreeBytes: 4 * GIB }, providers(), CLAUDE);
    expect(lvl(full, "texte").possible).toBe(true);
    expect(tr(lvl(full, "local").reason!, "en")).toMatch(/^not enough disk space/);
  });

  it("modèles déjà installés : rien à télécharger", () => {
    const pv = providers();
    for (const i of pv[0]!.items) i.status = "ok";
    expect(lvl(planLevels(cpuOnly, pv, CLAUDE), "texte").downloadBytes).toBe(0);
  });

  it("mémoire choisie à la main et cerveaux cloud lus dans le slot", () => {
    expect(withManualMemory(cpuOnly, 12 * GIB)).toMatchObject({ memory: "dedicated", modelBytes: 12 * GIB });
    expect(withManualMemory(nvidia, 0)).toMatchObject({ memory: "none", modelBytes: 0 });
    const settings = [{ key: "slot.brain.main", options: [{ value: "llm/gemma", label: "Gemma" }, { value: "claude/sonnet", label: "Claude", cloud: true }] }] as unknown as SettingInfo[];
    expect(cloudBrains(settings)).toEqual([{ value: "claude/sonnet", label: "Claude" }]);
  });
});

/** Noyau simulé : téléchargements instantanés (un tour de boucle), slots enregistrés, vitesses données. */
function fakeKernel(m: MachineInfo, speeds: number[], agents: Agent[] = []) {
  const snap = providers();
  const listeners = new Set<() => void>();
  const changes: [string, unknown][] = [];
  const ops: CatalogOp[] = [];
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
    borrowLlm: async () => ({ service: { baseURL: "http://llm", model: "m" }, release: () => {} }),
    idle: async () => {},
    retryMs: 0,
    // 2 appels par mesure : le 1er (chargement) n'est pas compté.
    fetch: (async () => {
      const v = speeds[Math.floor(speedIdx++ / 2)] ?? 0;
      return new Response(JSON.stringify({ timings: { predicted_per_second: v } }));
    }) as unknown as typeof fetch,
  };
  return { deps, changes, ops, snap };
}

const until = async (o: Onboarding, phase: OnboardingState["phase"]) => vi.waitFor(() => expect(o.state.phase).toBe(phase), { timeout: 2000 });

describe("installation d'un niveau", () => {
  it("texte : Floppy répond tout de suite (sans voix, cerveau cloud), puis l'écoute s'active une fois téléchargée", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    o.begin();
    expect(o.needed()).toBe(true);
    await o.plan();
    const states: OnboardingState[] = [];
    o.onState((s) => states.push(s));
    expect(o.apply("texte").ok).toBe(true);
    await until(o, "done");
    expect(k.ops.map((x) => (x as { id: string }).id)).toEqual(["silero-vad", "parakeet"]);
    // D'abord le minimum (avant tout téléchargement), puis l'écoute.
    expect(k.changes).toEqual([
      ["slot.voice.tts", "@none"],
      ["slot.brain.main", "claude/sonnet"],
      ["slot.listen.vad", "sherpa/silero-vad-item"],
      ["slot.listen.stt", "sherpa/parakeet-item"],
    ]);
    const firstLive = states.find((s) => s.live)!;
    expect(firstLive.rows.every((r) => r.state === "waiting")).toBe(true);
    expect(tr(firstLive.notes[0]!, "fr")).toBe("Floppy répond déjà par écrit, avec Claude.");
    expect(o.state.notes.map((n) => tr(n, "fr"))).toContain("Floppy t'entend : tu peux lui parler.");
    expect(states.some((s) => s.rows.some((r) => r.state === "downloading" && r.progress === 0.5))).toBe(true);
    expect(o.state.rows.every((r) => r.state === "ready")).toBe(true);
    expect(o.needed()).toBe(false);
    expect(JSON.parse(readFileSync(join(k.deps.home, "onboarding.json"), "utf8"))).toMatchObject({ done: true, level: "texte" });
  });

  it("modèle sur le disque mais pas dans la liste : « use » au lieu de télécharger", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.snap[0]!.items[0]!.status = "ok"; // silero sur le disque, sans élément (pas de uses)
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply("texte");
    await until(o, "done");
    expect(k.ops.map((x) => (x as { action: string }).action)).toEqual(["use", "download"]);
  });

  it("cerveau local trop lent : le cloud répond en attendant ; Floppy prend un plus petit, le télécharge et le teste", async () => {
    const k = fakeKernel(nvidia, [MIN_SPEED - 7, 40]);
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply("local");
    await until(o, "done");
    const brain = k.changes.filter(([key]) => key === "slot.brain.main").map(([, v]) => v);
    // Le cerveau trop lent n'est jamais branché : le cloud, puis le plus petit.
    expect(brain).toEqual(["claude/sonnet", "llm/gemma-12b-item"]);
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
    o.apply("local");
    await until(o, "done");
    expect(k.changes.filter(([key]) => key === "slot.brain.main").map(([, v]) => v)).toEqual(["claude/sonnet"]);
    expect(o.state.notes.map((n) => tr(n, "en"))).toContainEqual(expect.stringMatching(/too slow to talk: Floppy keeps Claude \(cloud\)\.$/));
  });

  it("échec d'un téléchargement : phase erreur, pas marqué fini ; au démarrage suivant, l'installation reprend", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.deps.run = async () => ({ ok: false, text: "réseau coupé" });
    const o = new Onboarding(k.deps);
    o.begin();
    await o.plan();
    o.apply("texte");
    await until(o, "error");
    expect(o.state.rows[0]).toMatchObject({ state: "error", text: "réseau coupé" });
    expect(o.state.live).toBe(true); // le cerveau cloud répond quand même
    expect(o.needed()).toBe(true);
    // Floppy relancé, le réseau revenu : la même installation reprend toute seule.
    const k2 = fakeKernel(cpuOnly, []);
    const o2 = new Onboarding({ ...k2.deps, home: k.deps.home });
    expect(await o2.resume()).toBe(true);
    await until(o2, "done");
    expect(o2.needed()).toBe(false);
    expect(await o2.resume()).toBe(false);
  });

  it("Passer : plus de fenêtre au démarrage ; une seule installation à la fois", async () => {
    const k = fakeKernel(cpuOnly, []);
    const o = new Onboarding(k.deps);
    o.begin();
    await o.plan();
    o.apply("texte");
    expect(o.apply("texte").ok).toBe(false);
    await until(o, "done");
    const o2 = new Onboarding({ ...k.deps, home: mkdtempSync(join(tmpdir(), "onb-")) });
    o2.begin();
    o2.skip();
    expect(o2.needed()).toBe(false);
  });
});

describe("Claude Code, Codex, Antigravity", () => {
  const manifests = [
    { id: "brain-claude-cli", addable: { section: "cerveau", label: "Claude Code", program: "claude" } },
    { id: "brain-codex-cli", addable: { section: "cerveau", label: "Codex", program: "codex" } },
    { id: "brain-agy-cli", addable: { section: "cerveau", label: "Antigravity", program: "agy" } },
    { id: "browser", addable: { section: "connecteurs", label: "Navigateur" } },
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

  it("Claude Code absent, Codex trouvé : le cerveau conseillé est Codex, à ajouter", () => {
    const a = findAgents(manifests, entries, (p) => (p === "codex" ? "/bin/codex" : undefined));
    const clouds = cloudBrains(settings, a, entries);
    expect(clouds).toEqual([{ value: "claude/sonnet", label: "Claude", plugin: "brain-claude-cli", found: false }]);
    const p = planLevels(cpuOnly, providers(), clouds, a);
    expect(p.brain).toBe("add:brain-codex-cli");
    expect(lvl(p, "texte").possible).toBe(true);
  });

  it("aucun programme trouvé et rien d'autre : les niveaux cloud disent quoi installer", () => {
    const a = findAgents(manifests, entries, () => undefined);
    const p = planLevels(cpuOnly, providers(), cloudBrains(settings, a, entries), a);
    expect(p.brain).toBeUndefined();
    expect(tr(lvl(p, "texte").reason!, "fr")).toMatch(/installe Claude Code, Codex ou Antigravity/);
  });

  it("installer avec « add:… » ajoute le plugin, puis prend son cerveau", async () => {
    const agents = findAgents(manifests, entries, (p) => (p === "codex" ? "/bin/codex" : undefined));
    const k = fakeKernel(cpuOnly, [], agents);
    const o = new Onboarding(k.deps);
    const plan = await o.plan();
    expect(plan.brain).toBe("add:brain-codex-cli");
    o.apply("texte");
    await until(o, "done");
    expect(k.ops.find((x) => x.op === "add")).toEqual({ op: "add", provider: "apps-cerveau", kind: "brain-codex-cli", values: {} });
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
    const p = planLevels(cpuOnly, pv, CLAUDE, [], offered);
    expect(ids(p, "voix")).toEqual(["silero-vad", "parakeet", "hortense"]);
    expect(lvl(p, "voix").downloadBytes).toBe(Math.round(50e6 * 0.8) + Math.round(1.3e9 * 0.8));
    // audio.cpp présent : Pocket TTS (bibliothèque) gagne.
    expect(ids(planLevels(cpuOnly, providers(), CLAUDE, [], offeredVoices(settings, providers())), "voix")).toContain("pocket-tts-french");
  });

  it("installation : la voix offerte est prête tout de suite et réglée dans le slot", async () => {
    const k = fakeKernel(cpuOnly, []);
    k.snap[1]!.missing = "audio.cpp introuvable";
    const base = k.deps.settings;
    k.deps.settings = () => [...base(), ...settings];
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply("voix");
    await until(o, "done");
    expect(k.changes).toContainEqual(["slot.voice.tts", "tts-system/hortense"]);
  });
});

describe("programmes à installer (llama.cpp, audio.cpp)", () => {
  /** Bibliothèques dont le programme manque, avec leurs versions à télécharger (GPU et processeur). */
  function withPrograms(): ProviderSnapshot[] {
    const pv = providers();
    pv[1]!.missing = "audio.cpp n'est pas installé";
    pv[2]!.missing = "llama.cpp n'est pas installé";
    const prog = (id: string, backend: string, size: number): ItemInfo => ({ id, label: id, enabled: true, service: "program", backend, size });
    pv.push(lib("voix-locale-program", "tts-local", [prog("audio-cuda", "cuda", 850e6), prog("audio-cpu", "cpu", 32e6)]));
    pv.push(lib("llm-local-program", "llm", [prog("llama-cuda", "cuda", 600e6), prog("llama-cpu", "cpu", 25e6)]));
    return pv;
  }

  it("un programme manquant mais téléchargeable ne bloque plus : il passe avant ses modèles", () => {
    const p = planLevels(nvidia, withPrograms(), CLAUDE);
    expect(p.levels.every((l) => l.possible)).toBe(true);
    // Voix sur le processeur : la petite version d'audio.cpp suffit.
    expect(ids(p, "voix")).toEqual(["audio-cpu", "silero-vad", "parakeet", "pocket-tts-french"]);
    // Voix sur la puce graphique et cerveau local : les versions CUDA.
    expect(ids(p, "local-max")).toEqual(["audio-cuda", "llama-cuda", "silero-vad", "parakeet", "qwen3-tts", "gemma-12b"]);
    expect(lvl(p, "local-max").downloadBytes).toBeGreaterThan(1.4e9);
  });

  it("programme déjà installé en version processeur : une voix de la puce graphique demande la mise à jour", () => {
    const pv = withPrograms();
    pv[1]!.missing = undefined;
    pv[3]!.items[1]!.status = "ok"; // audio-cpu installé
    const p = planLevels(nvidia, pv, CLAUDE);
    expect(ids(p, "voix")).not.toContain("audio-cpu");
    expect(ids(p, "hybride")[0]).toBe("audio-cuda");
  });

  it("installation : le programme est prêt quand il est installé, sans slot à régler", async () => {
    const k = fakeKernel(nvidia, [40]);
    k.snap.splice(0, k.snap.length, ...withPrograms());
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply("local");
    await until(o, "done");
    // L'écoute d'abord, puis la voix (avec son programme), puis le cerveau (avec le sien).
    expect(k.ops.map((x) => (x as { id: string }).id)).toEqual(["silero-vad", "parakeet", "audio-cpu", "pocket-tts-french", "llama-cuda", "mistral-24b"]);
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
  const withFound = (memory: number): ProviderSnapshot[] => [
    ...providers(),
    lib("llm-local-found", "llm", [{ ...it_("ollama-qwen3-8b", "llm", memory, "gpu"), size: 0, status: "ok" }]),
  ];

  it("un modèle trouvé assez grand passe devant un plus grand à télécharger : rien à télécharger pour le cerveau", () => {
    const p = planLevels(nvidia, withFound(7e9), CLAUDE);
    expect(ids(p, "local")).toContain("ollama-qwen3-8b");
    expect(lvl(p, "local").downloadBytes).toBe(lvl(planLevels(nvidia, providers(), CLAUDE), "voix").downloadBytes);
  });

  it("trop petit pour bien parler : le catalogue garde la main", () => {
    expect(ids(planLevels(nvidia, withFound(3e9), CLAUDE), "local")).toContain("mistral-24b");
  });

  it("installation : « use » l'ajoute à la liste ; s'il ne répond pas au test, le cerveau cloud reste", async () => {
    const k = fakeKernel(nvidia, []);
    k.snap.push(withFound(7e9).at(-1)!);
    k.deps.fetch = (async () => new Response("erreur", { status: 500 })) as unknown as typeof fetch;
    const o = new Onboarding(k.deps);
    await o.plan();
    o.apply("local");
    await until(o, "done");
    expect(k.ops).toContainEqual({ op: "action", provider: "llm-local-found", id: "ollama-qwen3-8b", action: "use" });
    expect(k.changes.filter(([key]) => key === "slot.brain.main").map(([, v]) => v)).toEqual(["claude/sonnet"]);
    expect(o.state.notes.map((n) => tr(n, "fr"))).toContainEqual(expect.stringMatching(/^ollama-qwen3-8b n'a pas répondu au test : Floppy garde le cerveau du cloud/));
  });
});
