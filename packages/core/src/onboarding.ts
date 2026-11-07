// Premier lancement : niveaux possibles selon la machine (du texte seul au tout local), puis installation du niveau choisi.
// Le plan vient des déclarations des plugins (bibliothèques de modèles : service, needs, uses) : aucun modèle en dur ici.
// Voir docs/spec/premier-lancement.md.
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./util/files.ts";
import type { CatalogOp, ItemInfo, ModelNeeds, OpReply, ProviderSnapshot } from "./catalog.ts";
import { GIB, gbText, machineSummary, type MachineInfo } from "./machine.ts";
import { T, tr, type Text } from "./i18n.ts";
import type { SettingInfo } from "./settings.ts";
import type { Kernel } from "./plugin/kernel.ts";
import { findExe } from "./util/process.ts";

/** « program » : le programme qui fait tourner des modèles (llama.cpp, audio.cpp), à installer avant eux. */
export type Role = "vad" | "stt" | "tts" | "llm" | "program";
const ROLES: Role[] = ["vad", "stt", "tts", "llm", "program"];
/** Slot réglé pour chaque rôle de modèle. */
export const ROLE_SLOT: Record<Exclude<Role, "program">, string> = { vad: "listen.vad", stt: "listen.stt", tts: "voice.tts", llm: "brain.main" };

export type LevelId = "texte" | "voix" | "hybride" | "local" | "local-max";
/** Du plus simple au plus complet. */
export const LEVELS: LevelId[] = ["texte", "voix", "hybride", "local", "local-max"];

/** En dessous, un cerveau local est trop faible pour bien utiliser les outils : le cloud est conseillé s'il est là. */
export const MIN_LOCAL_BRAIN = 6e9;
/** Jetons par seconde : en dessous, trop lent pour parler (une phrase en plus d'une seconde). */
export const MIN_SPEED = 15;

/** Un modèle de bibliothèque qui peut servir un rôle. */
export interface Candidate {
  provider: string;
  /** Entrée de config du plugin (début de la valeur d'un slot). */
  source: string;
  id: string;
  label: Text;
  role: Role;
  needs: ModelNeeds;
  installed: boolean;
  /** Installé : l'élément offert à choisir dans le slot. */
  uses?: string;
  /** Taille à télécharger. */
  size: number;
  /** Ce qui manque à son plugin (programme introuvable). */
  missing?: Text;
  /** Programme : son moteur (« cpu » : il ne fait pas tourner les modèles de la puce graphique). */
  backend?: string;
}

export interface Level {
  id: LevelId;
  label: Text;
  description: Text;
  voice: "none" | "cpu" | "gpu";
  brain: "cloud" | "local";
  picks: Candidate[];
  possible: boolean;
  /** Pourquoi ce niveau n'est pas possible. */
  reason?: Text;
  /** À télécharger (modèles pas encore sur le disque). */
  downloadBytes: number;
}

/** Un cerveau cloud déjà offert (option du slot brain.main). `found: false` : son programme est introuvable. */
export interface CloudBrain { value: string; label: Text; plugin?: string; found?: boolean }

/** Un plugin qui dépend d'un programme (Claude Code, Codex, Antigravity…), lu dans `manifest.addable.program`. */
export interface Agent {
  plugin: string;
  label: Text;
  program: string;
  section: string;
  /** Programme trouvé sur la machine. */
  found: boolean;
  /** Entrées de config qui utilisent déjà ce plugin (vide : à ajouter). */
  entries: string[];
}

/** Choix de cerveau « ajouter ce plugin, puis prendre son premier élément ». */
export const ADD_PREFIX = "add:";

export interface Plan {
  machine: MachineInfo;
  summary: Text;
  levels: Level[];
  recommended: LevelId;
  cloudBrains: CloudBrain[];
  /** Programmes de cerveau cherchés sur la machine (Claude Code, Codex, Antigravity). */
  agents: Agent[];
  /** Cerveau cloud conseillé : un déjà offert dont le programme est là, sinon un plugin trouvé à ajouter. */
  brain?: string;
  candidates: Candidate[];
}

const LEVEL_TEXT: Record<LevelId, { label: Text; description: Text }> = {
  texte: {
    label: T("Texte", "Text"),
    description: T("Tu parles, Floppy répond par écrit. Le cerveau est dans le cloud. Le plus léger.",
      "You speak, Floppy replies in writing. The brain is in the cloud. The lightest."),
  },
  voix: {
    label: T("Voix légère", "Light voice"),
    description: T("Floppy répond à voix haute, avec une voix qui tourne sur le processeur. Le cerveau est dans le cloud.",
      "Floppy replies out loud, with a voice that runs on the processor. The brain is in the cloud."),
  },
  hybride: {
    label: T("Voix expressive", "Expressive voice"),
    description: T("Une voix plus vivante, sur la puce graphique. Le cerveau est dans le cloud.",
      "A livelier voice, on the graphics chip. The brain is in the cloud."),
  },
  local: {
    label: T("Tout local", "All local"),
    description: T("Le cerveau tourne sur ta machine. La voix tourne sur le processeur.",
      "The brain runs on your computer. The voice runs on the processor."),
  },
  "local-max": {
    label: T("Tout local, au mieux", "All local, at its best"),
    description: T("Le cerveau et une voix expressive tournent sur ta machine.",
      "The brain and an expressive voice run on your computer."),
  },
};

const join2 = (parts: Text[], sep = ""): Text => T(parts.map((p) => tr(p, "fr")).join(sep), parts.map((p) => tr(p, "en")).join(sep));

/** Les modèles des bibliothèques qui disent leur rôle et ce qu'ils demandent. */
export function candidates(providers: ProviderSnapshot[]): Candidate[] {
  // Rôle « tts » d'une bibliothèque : une voix à télécharger. Les voix déjà offertes viennent de offeredVoices.
  const out: Candidate[] = [];
  for (const p of providers) {
    if (p.layout !== "library") continue;
    for (const it of p.items) {
      const role = it.service as Role | undefined;
      if (!role || !ROLES.includes(role) || (!it.needs && role !== "program")) continue;
      out.push({
        provider: p.id, source: p.source, id: it.id, label: it.label, role, needs: it.needs ?? { memory: 0, device: "cpu" },
        installed: it.status === "ok", size: it.size ?? 0,
        ...(it.uses ? { uses: it.uses } : {}), ...(p.missing ? { missing: p.missing } : {}), ...(it.backend ? { backend: it.backend } : {}),
      });
    }
  }
  return out;
}

/**
 * Voix déjà offertes, sans téléchargement et hors cloud (ex. voix du système) : un repli « processeur » quand aucune
 * voix de bibliothèque ne peut tourner. Mémoire 0 : une voix de bibliothèque qui tient passe devant.
 * Les voix d'un plugin dont le programme manque sont laissées de côté.
 */
export function offeredVoices(settings: SettingInfo[], providers: ProviderSnapshot[]): Candidate[] {
  const s = settings.find((x) => x.key === `slot.${ROLE_SLOT.tts}`);
  const broken = new Set(providers.filter((p) => p.missing).map((p) => p.source));
  const out: Candidate[] = [];
  for (const o of s?.options ?? []) {
    const cut = o.value.indexOf("/");
    if (cut < 1 || (o as { cloud?: boolean }).cloud) continue;
    const source = o.value.slice(0, cut);
    if (broken.has(source)) continue;
    out.push({ provider: "", source, id: o.value.slice(cut + 1), label: o.label, role: "tts", needs: { memory: 0, device: "cpu" }, installed: true, uses: o.value.slice(cut + 1), size: 0 });
  }
  return out;
}

/**
 * Les cerveaux cloud offerts (options du slot brain.main marquées cloud). Avec `agents` et `entries` (entrée → plugin) :
 * chacun dit si le programme de son plugin est là.
 */
export function cloudBrains(settings: SettingInfo[], agents: Agent[] = [], entries: { id: string; plugin: string }[] = []): CloudBrain[] {
  const s = settings.find((x) => x.key === `slot.${ROLE_SLOT.llm}`);
  return (s?.options ?? []).filter((o) => (o as { cloud?: boolean }).cloud).map((o) => {
    const plugin = entries.find((e) => e.id === o.value.slice(0, o.value.indexOf("/")))?.plugin;
    const agent = agents.find((a) => a.plugin === plugin);
    return { value: o.value, label: o.label, ...(plugin ? { plugin } : {}), ...(agent ? { found: agent.found } : {}) };
  });
}

/** Les plugins qui déclarent un programme (`addable.program`), et s'il est trouvé. */
export function findAgents(
  manifests: { id: string; addable?: { section: string; label: Text; program?: string } }[],
  entries: { id: string; plugin: string; fork?: unknown }[],
  find: (program: string) => string | undefined,
): Agent[] {
  return manifests.filter((m) => m.addable?.program).map((m) => ({
    plugin: m.id, label: m.addable!.label, program: m.addable!.program!, section: m.addable!.section,
    found: !!find(m.addable!.program!),
    entries: entries.filter((e) => e.plugin === m.id && !e.fork).map((e) => e.id),
  }));
}

/** Cerveaux cloud utilisables : offerts avec leur programme, puis plugins trouvés pas encore ajoutés. */
function usableBrains(clouds: CloudBrain[], agents: Agent[]): string[] {
  return [
    ...clouds.filter((c) => c.found !== false).map((c) => c.value),
    ...agents.filter((a) => a.found && !a.entries.length && a.section === "cerveau").map((a) => ADD_PREFIX + a.plugin),
  ];
}

interface Left { gpu: number; cpu: number }

/**
 * Le programme à installer pour ce modèle (même plugin). Rien à installer : `{}`. Impossible : `{ reason }`.
 * Un modèle de la puce graphique demande une version qui n'est pas « processeur » ; sinon la plus petite suffit.
 */
function programFor(c: Candidate, cands: Candidate[]): { fix?: Candidate; reason?: Text } {
  const progs = cands.filter((p) => p.role === "program" && p.source === c.source);
  const gpu = c.needs.device === "gpu";
  const inUse = progs.find((p) => p.installed);
  const enough = (p: Candidate) => !gpu || p.backend !== "cpu";
  if (!c.missing && (!inUse || enough(inUse))) return {};
  const fix = progs.filter((p) => !p.installed && enough(p)).sort((a, b) => a.size - b.size)[0];
  if (fix) return { fix };
  return { reason: c.missing ?? T("le programme installé ne sait pas utiliser la puce graphique", "the installed program cannot use the graphics chip") };
}

/** Pourquoi ce modèle ne tient pas (undefined : il tient). */
function misfit(c: Candidate, m: MachineInfo, left: Left, cands: Candidate[] = []): Text | undefined {
  const prog = programFor(c, cands);
  if (prog.reason) return prog.reason;
  if (c.needs.device === "cpu") {
    return c.needs.memory <= left.cpu ? undefined
      : join2([T("il manque ", "missing "), gbText(c.needs.memory - left.cpu), T(" de RAM", " of RAM")]);
  }
  if (m.memory === "none") return T("il faut une puce graphique", "needs a graphics chip");
  const b = c.needs.backends;
  if (b?.length && !b.some((x) => m.backends.includes(x))) {
    return b.length === 1 && b[0] === "cuda" ? T("demande une carte NVIDIA", "needs an NVIDIA card")
      : T(`demande le moteur ${b.join(" ou ")}`, `needs the ${b.join(" or ")} engine`);
  }
  return c.needs.memory <= left.gpu ? undefined : join2([T("il manque ", "missing "), gbText(c.needs.memory - left.gpu)]);
}

/**
 * Le meilleur modèle d'un rôle qui tient : celui qui demande le plus (les petits sont moins bons) ; installé d'abord.
 * Cerveau : un modèle déjà sur la machine (LM Studio, Ollama, déjà téléchargé) passe devant s'il est assez grand,
 * pour ne rien télécharger.
 */
function best(cands: Candidate[], role: Role, device: "cpu" | "gpu" | undefined, m: MachineInfo, left: Left): { pick?: Candidate; reason?: Text } {
  const list = cands.filter((c) => c.role === role && (!device || c.needs.device === device));
  if (!list.length) return { reason: T(`aucun modèle proposé pour : ${roleName(role).fr}`, `no model offered for: ${roleName(role).en}`) };
  const ok = list.filter((c) => !misfit(c, m, left, cands));
  if (ok.length) {
    const have = (c: Candidate) => Number(role === "llm" && c.installed && c.needs.memory >= MIN_LOCAL_BRAIN);
    ok.sort((a, b) => have(b) - have(a) || b.needs.memory - a.needs.memory || Number(b.installed) - Number(a.installed));
    return { pick: ok[0]! };
  }
  // La raison du plus petit : c'est lui qui était le plus près de tenir.
  const smallest = [...list].sort((a, b) => a.needs.memory - b.needs.memory)[0]!;
  return { reason: join2([roleName(role), T(" : ", ": "), misfit(smallest, m, left, cands)!]) };
}

function roleName(role: Role): { fr: string; en: string } {
  return {
    vad: { fr: "détecteur de parole", en: "speech detector" },
    stt: { fr: "transcription", en: "transcription" },
    tts: { fr: "voix", en: "voice" },
    llm: { fr: "cerveau", en: "brain" },
    program: { fr: "programme", en: "program" },
  }[role];
}

/** Retire un modèle choisi du budget. Mémoire unifiée : processeur et puce graphique prennent dans la même RAM. */
function use(c: Candidate, m: MachineInfo, left: Left): void {
  const n = c.needs.memory;
  if (c.needs.device === "cpu") { left.cpu -= n; if (m.memory === "unified") left.gpu -= n; }
  else { left.gpu -= n; if (m.memory === "unified") left.cpu -= n; }
}

function buildLevel(id: LevelId, m: MachineInfo, cands: Candidate[], clouds: string[]): Level {
  const voice: Level["voice"] = id === "texte" ? "none" : id === "voix" || id === "local" ? "cpu" : "gpu";
  const brain: Level["brain"] = id === "local" || id === "local-max" ? "local" : "cloud";
  const left: Left = { gpu: m.modelBytes, cpu: m.cpuBytes };
  const picks: Candidate[] = [];
  let reason: Text | undefined;
  const take = (role: Role, device?: "cpu" | "gpu") => {
    const r = best(cands, role, device, m, left);
    if (r.pick) { picks.push(r.pick); use(r.pick, m, left); } else reason ??= r.reason;
  };
  take("vad");
  take("stt");
  if (voice !== "none") take("tts", voice);
  // La voix d'abord : sa taille est fixe ; le cerveau prend le plus grand qui tient dans le reste.
  if (brain === "local") take("llm");
  else if (!clouds.length) reason ??= T("aucun cerveau dans le cloud : installe Claude Code, Codex ou Antigravity, ou ajoute une clé (Réglages → Cerveau)",
    "no cloud brain: install Claude Code, Codex or Antigravity, or add a key (Settings → Brain)");
  // Les programmes à installer (llama.cpp, audio.cpp) passent avant leurs modèles : une ligne par programme.
  const progs = new Map<string, Candidate>();
  for (const p of picks) { const fix = programFor(p, cands).fix; if (fix) { const cur = progs.get(fix.source); if (!cur || (cur.backend === "cpu" && fix.backend !== "cpu")) progs.set(fix.source, fix); } }
  picks.unshift(...progs.values());
  const downloadBytes = picks.filter((p) => !p.installed).reduce((n, p) => n + p.size, 0);
  if (!reason && m.diskFreeBytes !== undefined && downloadBytes > m.diskFreeBytes - 2 * GIB) {
    reason = join2([T("pas assez de place sur le disque : il faut ", "not enough disk space: needs "), gbText(downloadBytes + 2 * GIB)]);
  }
  return { id, ...LEVEL_TEXT[id], voice, brain, picks, possible: !reason, ...(reason ? { reason } : {}), downloadBytes };
}

/**
 * L'ordre d'installation : un bloc par fonction, chacun avec son programme (llama.cpp, audio.cpp).
 * L'écoute d'abord : Floppy entend vite. Puis la voix et le cerveau ; sans cerveau qui répond déjà (cloud),
 * le cerveau passe avant la voix.
 */
export function installSteps(picks: Candidate[], brainReady: boolean): Candidate[][] {
  const taken = new Set<Candidate>();
  const group = (roles: Role[]): Candidate[] => {
    const models = picks.filter((p) => roles.includes(p.role));
    const progs = picks.filter((p) => p.role === "program" && !taken.has(p) && models.some((m) => m.source === p.source));
    const out = [...progs, ...models];
    for (const p of out) taken.add(p);
    return out;
  };
  const listen = group(["vad", "stt"]);
  const order = brainReady ? [listen, group(["tts"]), group(["llm"])] : [listen, group(["llm"]), group(["tts"])];
  const rest = picks.filter((p) => !taken.has(p));
  return [...order, rest].filter((s) => s.length);
}

/** Les niveaux et le conseil : le plus haut niveau possible (un cerveau local trop petit laisse passer le cloud devant). */
export function planLevels(m: MachineInfo, providers: ProviderSnapshot[], clouds: CloudBrain[], agents: Agent[] = [], offered: Candidate[] = []): Plan {
  const cands = [...candidates(providers), ...offered];
  const usable = usableBrains(clouds, agents);
  const levels = LEVELS.map((id) => buildLevel(id, m, cands, usable));
  const ok = levels.filter((l) => l.possible);
  const good = (l: Level) => l.brain === "cloud" || !usable.length || (l.picks.find((p) => p.role === "llm")?.needs.memory ?? 0) >= MIN_LOCAL_BRAIN;
  const recommended = [...ok].reverse().find(good)?.id ?? ok.at(-1)?.id ?? "texte";
  return {
    machine: m, summary: machineSummary(m), levels, recommended, cloudBrains: clouds, agents,
    ...(usable[0] ? { brain: usable[0] } : {}), candidates: cands,
  };
}

/** Mémoire choisie à la main (rien n'a été lu) : 0 = pas de puce graphique. */
export function withManualMemory(m: MachineInfo, bytes: number): MachineInfo {
  if (bytes <= 0) return { ...m, memory: "none", modelBytes: 0, backends: [] };
  return { ...m, memory: m.memory === "none" ? "dedicated" : m.memory, modelBytes: bytes, backends: m.backends.length ? m.backends : ["vulkan"] };
}

// ------------------------------------------------------------------ installation

/** Ce que la mesure de vitesse lit d'un modèle en service (contrat complet : `llm` de @floppy/contracts). */
export interface MeasuredLlm { baseURL?: string; model: string }

export interface OnboardingDeps {
  home: string;
  snapshot(): Promise<ProviderSnapshot[]>;
  run(op: CatalogOp): Promise<OpReply>;
  settings(): SettingInfo[];
  /** Plugins à programme (Claude Code, Codex, Antigravity) et entrées de config (entrée → plugin). */
  agents(): Agent[];
  entries(): { id: string; plugin: string }[];
  change(key: string, value: unknown): Promise<{ ok: boolean; text: Text }>;
  onItems(fn: () => void): () => void;
  machine(fresh?: boolean): Promise<MachineInfo>;
  borrowLlm(value: string): Promise<{ service: MeasuredLlm; release(): void } | undefined>;
  /** Attend que le noyau ait fini ses changements (éléments ajoutés → slots recalculés). */
  idle(): Promise<void>;
  fetch?: typeof fetch;
  /** Attente entre deux essais (tests : 0). */
  retryMs?: number;
}

export type RowState = "waiting" | "downloading" | "ready" | "error";
export interface OnboardingRow { key: string; role: Role; label: Text; state: RowState; progress?: number; text?: Text }
export interface OnboardingState {
  phase: "idle" | "installing" | "testing" | "done" | "error";
  level?: LevelId;
  rows: OnboardingRow[];
  /** Phrases à montrer (ce qui vient de s'activer, descente de niveau, vitesse mesurée, fin). */
  notes: Text[];
  speed?: number;
  /** Floppy répond déjà (un cerveau est réglé) : le reste arrive en fond. */
  live?: boolean;
}
/** `level` sans `done` : une installation coupée (Floppy fermé), reprise au démarrage. */
export interface OnboardingFile { done: boolean; level?: LevelId; brain?: string; skipped?: boolean; at?: string }

const rowKey = (c: Candidate) => `${c.provider}/${c.id}`;

export class Onboarding {
  private readonly deps: OnboardingDeps;
  private plan_: Plan | undefined;
  private st: OnboardingState = { phase: "idle", rows: [], notes: [] };
  private readonly listeners = new Set<(s: OnboardingState) => void>();

  constructor(deps: OnboardingDeps) { this.deps = deps; }

  private get path(): string { return join(this.deps.home, "onboarding.json"); }

  read(): OnboardingFile | undefined {
    return readJsonFile<OnboardingFile>(this.path);
  }
  private write(f: OnboardingFile): void { writeJsonAtomic(this.path, f); }

  /** Premier lancement : à faire jusqu'à la fin (ou « Passer »). */
  begin(): void { if (!this.read()) this.write({ done: false }); }
  /** La fenêtre doit-elle s'ouvrir au démarrage ? */
  needed(): boolean { const f = this.read(); return !!f && !f.done; }
  skip(): void { this.write({ done: true, skipped: true, at: new Date().toISOString() }); }

  get state(): OnboardingState { return this.st; }

  /** Installation coupée (Floppy fermé pendant les téléchargements) : la reprend. Rien à reprendre : false. */
  async resume(): Promise<boolean> {
    const f = this.read();
    if (!f || f.done || !f.level || this.st.phase !== "idle") return false;
    await this.plan();
    return this.apply(f.level, f.brain ? { brain: f.brain } : {}).ok;
  }
  onState(fn: (s: OnboardingState) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { const s = { ...this.st, rows: this.st.rows.map((r) => ({ ...r })), notes: [...this.st.notes] }; for (const fn of this.listeners) fn(s); }

  /** Lit la machine et calcule les niveaux. `manualBytes` : mémoire choisie à la main (rien n'a été lu). */
  async plan(opts: { fresh?: boolean; manualBytes?: number } = {}): Promise<Plan> {
    let m = await this.deps.machine(opts.fresh);
    if (opts.manualBytes !== undefined) m = withManualMemory(m, opts.manualBytes);
    const agents = this.deps.agents();
    const settings = this.deps.settings();
    const snap = await this.deps.snapshot();
    this.plan_ = planLevels(m, snap, cloudBrains(settings, agents, this.deps.entries()), agents, offeredVoices(settings, snap));
    return this.plan_;
  }

  /** Installe un niveau (rend la main tout de suite ; l'avancement passe par onState). */
  apply(level: LevelId, opts: { brain?: string } = {}): { ok: boolean; text: Text } {
    if (this.st.phase === "installing" || this.st.phase === "testing") return { ok: false, text: T("Une installation est déjà en cours.", "An installation is already running.") };
    const plan = this.plan_;
    const l = plan?.levels.find((x) => x.id === level);
    if (!plan || !l) return { ok: false, text: T("Niveau inconnu : relis la machine.", "Unknown level: read the machine again.") };
    const brain = opts.brain ?? plan.brain;
    const steps = installSteps(l.picks, !!brain && (l.brain === "cloud" || l.picks.some((p) => p.role === "llm")));
    this.st = { phase: "installing", level, rows: steps.flat().map((p) => ({ key: rowKey(p), role: p.role, label: p.label, state: "waiting" })), notes: [] };
    this.emit();
    void this.run(plan, l, brain, steps).catch((e) => {
      this.st.phase = "error";
      this.st.notes.push(e instanceof Error ? T(`Échec : ${e.message}`, `Failed: ${e.message}`) : T("Échec.", "Failed."));
      this.emit();
    });
    return { ok: true, text: T("Installation lancée.", "Installation started.") };
  }

  /**
   * Floppy marche tout de suite avec le minimum (réponses écrites, cerveau cloud s'il y en a un), puis chaque bloc
   * s'active dès qu'il est téléchargé : l'écoute d'abord, puis la voix et le cerveau local.
   */
  private async run(plan: Plan, l: Level, brain: string | undefined, steps: Candidate[][]): Promise<void> {
    // Noté avant les téléchargements : Floppy fermé en route, l'installation reprend au démarrage.
    this.write({ done: false, level: l.id, ...(brain ? { brain } : {}) });
    const local = l.picks.find((p) => p.role === "llm");
    const cloud = brain && (l.brain === "cloud" || local) ? await this.cloudBrain(plan, brain) : undefined;
    // Pas de voix, ou une voix à télécharger : réponses écrites en attendant.
    const tts = l.picks.find((p) => p.role === "tts");
    if (!tts || tts.provider) await this.setSlot(ROLE_SLOT.tts, "@none");
    if (cloud) {
      await this.setSlot(ROLE_SLOT.llm, cloud);
      this.st.live = true;
      const name = plan.cloudBrains.find((c) => c.value === cloud)?.label ?? T("le cerveau du cloud", "the cloud brain");
      this.st.notes.push(local
        ? join2([T("Floppy répond déjà par écrit, avec ", "Floppy already replies in writing, with "), name, T(" en attendant le cerveau local.", " until the local brain is ready.")])
        : join2([T("Floppy répond déjà par écrit, avec ", "Floppy already replies in writing, with "), name, T(".", ".")]));
    }
    this.emit();
    let failed = false;
    for (const step of steps) {
      const got = await this.install(step);
      if (!got) { failed = true; continue; }
      await this.deps.idle();
      await this.activate(plan, got, cloud);
    }
    if (failed) {
      // Pas marqué fini : au prochain démarrage, l'installation reprend (les blocs déjà là sont prêts tout de suite).
      this.st.phase = "error";
      this.st.notes.push(T("Un téléchargement a échoué : Floppy marche avec le reste. Il réessaiera au prochain démarrage, ou choisis un autre niveau.",
        "A download failed: Floppy works with the rest. It will try again at the next start, or choose another level."));
      this.emit();
      return;
    }
    this.write({ done: true, level: l.id, at: new Date().toISOString() });
    this.st.phase = "done";
    this.st.notes.push(T("Tout est installé.", "Everything is installed."));
    this.emit();
  }

  /** Branche un bloc qui vient d'arriver (son slot) et le dit. Le cerveau local passe d'abord le test de vitesse. */
  private async activate(plan: Plan, got: Candidate[], cloud: string | undefined): Promise<void> {
    for (const p of got) {
      if (p.role === "program") continue;
      if (p.role === "llm") await this.localBrain(plan, p, cloud);
      else await this.setSlot(ROLE_SLOT[p.role], `${p.source}/${p.uses}`);
    }
    if (got.some((p) => p.role === "stt")) this.st.notes.push(T("Floppy t'entend : tu peux lui parler.", "Floppy hears you: you can talk to it."));
    const voice = got.find((p) => p.role === "tts");
    if (voice) this.st.notes.push(join2([T("Floppy parle maintenant avec la voix ", "Floppy now speaks with the voice "), voice.label, T(".", ".")]));
    this.emit();
  }

  /** Télécharge (ou ajoute à la liste) chaque modèle, attend qu'ils soient tous prêts. Rend les modèles avec leur `uses`. */
  private install(picks: Candidate[]): Promise<Candidate[] | undefined> {
    const asked = new Set<string>();
    return new Promise((resolve) => {
      let busy = false;
      let again = false;
      let off = () => {};
      const finish = (v: Candidate[] | undefined) => { off(); resolve(v); };
      const check = async (): Promise<void> => {
        if (busy) { again = true; return; }
        busy = true;
        try {
          const snap = await this.deps.snapshot();
          const found = (p: Candidate): ItemInfo | undefined => snap.find((s) => s.id === p.provider)?.items.find((i) => i.id === p.id);
          const out: Candidate[] = [];
          let failed = false;
          let pending = false;
          for (const p of picks) {
            const it = found(p);
            const row = this.st.rows.find((r) => r.key === rowKey(p));
            if (!row) continue;
            // Élément déjà offert (voix du système) : rien à télécharger.
            if (!p.provider) { row.state = "ready"; out.push(p); continue; }
            // Un programme est prêt une fois installé ; un modèle, une fois dans la liste de son plugin (uses).
            if (it?.status === "ok" && (it.uses || p.role === "program")) {
              row.state = "ready"; delete row.progress; delete row.text;
              out.push({ ...p, installed: true, ...(it.uses ? { uses: it.uses } : {}) });
              continue;
            }
            if (it?.status === "loading") { row.state = "downloading"; if (it.progress !== undefined) row.progress = it.progress; pending = true; continue; }
            if (it?.status === "error" && asked.has(rowKey(p))) { row.state = "error"; if (it.statusText) row.text = it.statusText; failed = true; continue; }
            pending = true;
            if (!asked.has(rowKey(p))) {
              asked.add(rowKey(p));
              // Sur le disque mais pas dans la liste : « use » ; sinon « download ».
              const action = it?.status === "ok" ? "use" : "download";
              const r = await this.deps.run({ op: "action", provider: p.provider, id: p.id, action });
              if (!r.ok) { row.state = "error"; row.text = r.text; failed = true; pending = false; }
            }
          }
          this.emit();
          if (out.length === picks.length) return finish(out);
          if (failed && !pending) return finish(undefined);
        } finally {
          busy = false;
          if (again) { again = false; void check(); }
        }
      };
      off = this.deps.onItems(() => { void check(); });
      void check();
    });
  }

  /**
   * Valeur du cerveau cloud. « add:<plugin> » : ajoute le plugin (Claude Code, Codex, Antigravity trouvé sur la machine),
   * puis prend son premier élément offert.
   */
  private async cloudBrain(plan: Plan, brain: string): Promise<string | undefined> {
    if (!brain.startsWith(ADD_PREFIX)) return brain;
    const agent = plan.agents.find((a) => a.plugin === brain.slice(ADD_PREFIX.length));
    if (!agent) return undefined;
    const r = await this.deps.run({ op: "add", provider: `apps-${agent.section}`, kind: agent.plugin, values: {} });
    if (!r.ok || !r.id) {
      this.st.notes.push(join2([agent.label, T(" n'a pas pu être ajouté : ", " could not be added: "), r.text]));
      return undefined;
    }
    for (let i = 0; i < 10; i++) {
      await this.deps.idle();
      const opt = cloudBrains(this.deps.settings()).find((c) => c.value.startsWith(`${r.id}/`));
      if (opt) {
        this.st.notes.push(join2([agent.label, T(" est ajouté.", " is added.")]));
        plan.cloudBrains.push({ ...opt, plugin: agent.plugin, found: true });
        return opt.value;
      }
      await new Promise((ok) => setTimeout(ok, this.deps.retryMs ?? 300));
    }
    this.st.notes.push(join2([agent.label, T(" est ajouté, mais n'offre pas encore de cerveau : choisis-le dans les réglages.", " is added, but offers no brain yet: choose it in the settings.")]));
    return undefined;
  }

  /** Change un slot ; l'élément vient peut-être d'être ajouté : quelques essais. */
  private async setSlot(slot: string, value: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const r = await this.deps.change(`slot.${slot}`, value);
      if (r.ok) return;
      await this.deps.idle();
      await new Promise((ok) => setTimeout(ok, this.deps.retryMs ?? 300));
    }
    this.st.notes.push(T(`Le rôle ${slot} n'a pas pu être réglé : choisis-le dans les réglages.`, `The ${slot} role could not be set: choose it in the settings.`));
  }

  /**
   * Mesure le cerveau local AVANT de le brancher (le cerveau cloud répond pendant ce temps).
   * Assez rapide : il prend la place. Trop lent : un plus petit (téléchargé à son tour), sinon le cerveau cloud reste.
   */
  private async localBrain(plan: Plan, first: Candidate, cloud: string | undefined): Promise<void> {
    let cur = first;
    const take = async (c: Candidate) => { await this.setSlot(ROLE_SLOT.llm, `${c.source}/${c.uses}`); this.st.live = true; };
    for (;;) {
      this.st.phase = "testing";
      this.emit();
      const speed = await this.measure(`${cur.source}/${cur.uses}`);
      this.st.phase = "installing";
      if (speed === undefined) {
        // Le modèle ne répond pas (fichier que llama.cpp ne sait pas lire ?) : le cerveau cloud reste, s'il y en a un.
        if (cloud) {
          this.st.notes.push(join2([cur.label, T(" n'a pas répondu au test : Floppy garde le cerveau du cloud. Tu peux le choisir plus tard dans les réglages.",
            " did not answer the test: Floppy keeps the cloud brain. You can choose it later in the settings.")]));
          return;
        }
        await take(cur);
        this.st.notes.push(T("Le test de vitesse du cerveau n'a pas pu se faire : le cerveau local est pris quand même.",
          "The brain speed test could not run: the local brain is used anyway."));
        return;
      }
      this.st.speed = Math.round(speed);
      const n = Math.round(speed);
      if (speed >= MIN_SPEED) {
        await take(cur);
        this.st.notes.push(join2([cur.label, T(` répond à ${n} jetons par seconde : c'est lui qui répond maintenant.`, ` answers at ${n} tokens per second: it now does the answering.`)]));
        this.emit();
        return;
      }
      const slow = join2([cur.label, T(` répondait à ${n} jetons par seconde, trop lent pour parler`, ` answered at ${n} tokens per second, too slow to talk`)]);
      const smaller = plan.candidates.filter((c) => c.role === "llm" && !c.missing && c.needs.memory < cur.needs.memory).sort((a, b) => b.needs.memory - a.needs.memory)[0];
      if (smaller) {
        this.st.notes.push(join2([slow, T(" : Floppy prend ", ": Floppy takes "), smaller.label, T(".", ".")]));
        this.st.rows.push({ key: rowKey(smaller), role: "llm", label: smaller.label, state: "waiting" });
        this.emit();
        const got = await this.install([smaller]);
        if (!got?.[0]) {
          this.st.notes.push(T("Le modèle plus petit n'a pas pu être installé.", "The smaller model could not be installed."));
          if (!cloud) await take(cur);
          return;
        }
        await this.deps.idle();
        cur = got[0];
        continue;
      }
      const fallback = plan.cloudBrains.find((c) => c.value === cloud) ?? plan.cloudBrains.find((c) => c.found !== false);
      if (fallback) {
        if (fallback.value !== cloud) await this.setSlot(ROLE_SLOT.llm, fallback.value);
        this.st.live = true;
        this.st.notes.push(join2([slow, T(" : Floppy garde ", ": Floppy keeps "), fallback.label, T(" (cloud).", " (cloud).")]));
      } else {
        await take(cur);
        this.st.notes.push(join2([slow, T(". Pas d'autre cerveau : il reste choisi.", ". No other brain: it stays chosen.")]));
      }
      this.emit();
      return;
    }
  }

  /** Jetons par seconde : 2 réponses courtes (la 1re charge le modèle et n'est pas comptée). */
  private async measure(value: string): Promise<number | undefined> {
    const b = await this.deps.borrowLlm(value).catch(() => undefined);
    if (!b) return undefined;
    const f = this.deps.fetch ?? fetch;
    try {
      const svc = b.service;
      if (!svc.baseURL) return undefined;
      const once = async (): Promise<number | undefined> => {
        const t0 = performance.now();
        const r = await f(`${svc.baseURL}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: svc.model, temperature: 0, max_tokens: 48,
            messages: [{ role: "user", content: "Décris en trois phrases une journée à la mer." }],
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!r.ok) return undefined;
        const j = await r.json() as { timings?: { predicted_per_second?: number }; usage?: { completion_tokens?: number } };
        const secs = (performance.now() - t0) / 1000;
        return j.timings?.predicted_per_second ?? (j.usage?.completion_tokens && secs > 0 ? j.usage.completion_tokens / secs : undefined);
      };
      await once();
      return await once();
    } catch { return undefined; } finally { b.release(); }
  }
}

/** L'onboarding branché sur un noyau (même chemin que la fenêtre des réglages : origine « ui »). */
export function onboardingFor(kernel: Kernel): Onboarding {
  return new Onboarding({
    home: kernel.home,
    snapshot: () => kernel.items.snapshot(),
    run: (op) => kernel.items.run(op, "ui"),
    settings: () => kernel.settings.list(),
    agents: () => findAgents(kernel.manifests(), kernel.status(), (p) => findExe(p)),
    entries: () => kernel.status().filter((e) => !e.fork).map((e) => ({ id: e.id, plugin: e.plugin })),
    change: (key, value) => kernel.settings.change(key, value, "ui"),
    onItems: (fn) => kernel.items.onChange(fn),
    machine: (fresh) => kernel.machine(fresh),
    borrowLlm: (value) => kernel.borrowItem<MeasuredLlm>("llm", value),
    idle: () => kernel.idle(),
  });
}
