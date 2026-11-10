// Premier lancement : un choix de modèle par rôle (cerveau, écoute, voix) avec UN conseillé par rôle (selon la machine et
// la langue de l'assistant), puis installation de la sélection.
// Le plan vient des déclarations des plugins (bibliothèques de modèles : service, needs, languages, uses) : aucun modèle en dur ici.
// Voir docs/spec/premier-lancement.md.
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic, findExe, T, tr, GIB, gbText, machineSummary, type CatalogOp, type ItemInfo, type ModelNeeds, type LanguageLevel, type LanguageSupport, type OpReply, type ProviderSnapshot, type MachineInfo, type Text, type SettingInfo, type Kernel } from "@floppy/core";

/** « program » : le programme qui fait tourner des modèles (llama.cpp, audio.cpp), à installer avant eux. */
export type Role = "vad" | "stt" | "tts" | "llm" | "program";
const ROLES: Role[] = ["vad", "stt", "tts", "llm", "program"];
/** Slot réglé pour chaque rôle de modèle. */
export const ROLE_SLOT: Record<Exclude<Role, "program">, string> = { vad: "listen.vad", stt: "listen.stt", tts: "voice.tts", llm: "brain.main" };

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
  description?: Text;
  /** Sa note par langue (langue absente : inconnue). */
  languages?: LanguageSupport;
  sample?: string;
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

/** Choix de voix « pas de voix » : Floppy répond par écrit. */
export const NO_VOICE = "@none";

export type ChoiceRole = "brain" | "stt" | "tts";
const ROLE_OF: Record<ChoiceRole, Role> = { brain: "llm", stt: "stt", tts: "tts" };

/** Un modèle (ou un cerveau, ou « pas de voix ») qu'on peut choisir pour un rôle. */
export interface Choice {
  /** Valeur à renvoyer dans Selection. */
  value: string;
  /** « local » : modèle de bibliothèque ; « cloud » : cerveau cloud (ou « add:<plugin> ») ; « offered » : voix déjà offerte ; « none » : pas de voix. */
  kind: "local" | "cloud" | "offered" | "none";
  label: Text;
  description?: Text;
  /** Tient dans la machine (l'écoute est déjà réservée). */
  fits: boolean;
  /** Pourquoi il ne tient pas. */
  reason?: Text;
  installed: boolean;
  /** Octets à télécharger, programme compris. */
  size: number;
  device?: "cpu" | "gpu";
  /** Note pour la langue de l'assistant ; absent : inconnue. */
  language?: LanguageLevel;
  /** Court extrait sonore (http(s)), s'il existe. */
  sample?: string;
  recommended: boolean;
}

/** Ce que l'utilisateur a choisi : la `value` d'un choix par rôle. Rôle absent : rien n'est changé pour lui (voix : « pas de voix »). */
export interface Selection { brain?: string; stt?: string; tts?: string }

export interface Plan {
  machine: MachineInfo;
  summary: Text;
  /** Langue de l'assistant (code à 2 lettres) pour laquelle le conseil est calculé. */
  language: string;
  choices: Record<ChoiceRole, Choice[]>;
  /** Un conseil par rôle (au plus) ; les trois tiennent ensemble dans la machine. */
  recommended: Selection;
  cloudBrains: CloudBrain[];
  /** Programmes de cerveau cherchés sur la machine (Claude Code, Codex, Antigravity). */
  agents: Agent[];
  /** Cerveau cloud utilisable : un déjà offert dont le programme est là, sinon un plugin trouvé à ajouter. Répond en attendant le cerveau local. */
  brain?: string;
  candidates: Candidate[];
}

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
        ...(it.detail ? { description: it.detail } : {}), ...(it.languages ? { languages: it.languages } : {}), ...(it.sample ? { sample: it.sample } : {}),
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

/** Octets à télécharger pour ce modèle : ses fichiers (s'il n'est pas là) et le programme qu'il faut installer avant lui. */
function downloadSize(c: Candidate, cands: Candidate[]): number {
  return (c.installed ? 0 : c.size) + (programFor(c, cands).fix?.size ?? 0);
}

/** Pourquoi ce modèle ne peut pas être pris maintenant : il ne tient pas dans la machine, ou le disque est trop plein. */
function unfit(c: Candidate, m: MachineInfo, left: Left, cands: Candidate[]): Text | undefined {
  const why = misfit(c, m, left, cands);
  if (why) return why;
  const need = downloadSize(c, cands);
  if (m.diskFreeBytes !== undefined && need > 0 && need > m.diskFreeBytes - 2 * GIB) {
    return join2([T("pas assez de place sur le disque : il faut ", "not enough disk space: needs "), gbText(need + 2 * GIB)]);
  }
  return undefined;
}

/** Code de langue à 2 lettres, en minuscules (« fr », « en »). */
const langCode = (lang: string): string => lang.slice(0, 2).toLowerCase();
/** Bonne note d'abord ; langue inconnue avant une mauvaise note (« poor » : conseillé seulement s'il n'y a rien d'autre). */
const LANG_SCORE: Record<LanguageLevel, number> = { good: 3, fair: 2, poor: 0 };
const langScore = (c: Candidate, lang: string): number => { const l = c.languages?.[lang]; return l ? LANG_SCORE[l] : 1; };

/**
 * Le meilleur ordre pour un rôle : la meilleure note pour la langue, puis celui qui demande le plus de mémoire (les petits
 * sont moins bons), installé d'abord.
 * Cerveau : un modèle déjà sur la machine (LM Studio, Ollama, déjà téléchargé) passe devant s'il est assez grand, pour ne rien télécharger.
 */
function byRank(lang: string) {
  const have = (c: Candidate) => Number(c.role === "llm" && c.installed && c.needs.memory >= MIN_LOCAL_BRAIN);
  return (a: Candidate, b: Candidate) => langScore(b, lang) - langScore(a, lang) || have(b) - have(a) || b.needs.memory - a.needs.memory || Number(b.installed) - Number(a.installed);
}

/** Les modèles d'un rôle qui tiennent, le meilleur d'abord. */
function fitting(cands: Candidate[], role: Role, m: MachineInfo, left: Left, lang: string): Candidate[] {
  return cands.filter((c) => c.role === role && !unfit(c, m, left, cands)).sort(byRank(lang));
}

/** Retire un modèle choisi du budget. Mémoire unifiée : processeur et puce graphique prennent dans la même RAM. */
function use(c: Candidate, m: MachineInfo, left: Left): void {
  const n = c.needs.memory;
  if (c.needs.device === "cpu") { left.cpu -= n; if (m.memory === "unified") left.gpu -= n; }
  else { left.gpu -= n; if (m.memory === "unified") left.cpu -= n; }
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

/** Valeur d'un modèle dans Selection : `<fournisseur>/<id>` (bibliothèque) ou `<entrée>/<élément>` (voix déjà offerte). */
const valueOf = (c: Candidate): string => (c.provider ? `${c.provider}/${c.id}` : `${c.source}/${c.uses}`);

/** Le détecteur de parole : le meilleur qui tient (il suit toujours la transcription). */
function pickVad(cands: Candidate[], m: MachineInfo, lang = "fr"): Candidate | undefined {
  return fitting(cands, "vad", m, { gpu: m.modelBytes, cpu: m.cpuBytes }, lang)[0];
}

/** Les programmes à installer (llama.cpp, audio.cpp) pour ces modèles : un par plugin, la version qui sert la puce graphique si l'un d'eux le demande. */
function programsFor(models: Candidate[], cands: Candidate[]): Candidate[] {
  const progs = new Map<string, Candidate>();
  for (const p of models) {
    const fix = programFor(p, cands).fix;
    if (!fix) continue;
    const cur = progs.get(fix.source);
    if (!cur || (cur.backend === "cpu" && fix.backend !== "cpu")) progs.set(fix.source, fix);
  }
  return [...progs.values()];
}

/**
 * Les choix par rôle et le conseil. Écoute d'abord (détecteur + transcription conseillée), puis la voix, puis le cerveau dans
 * ce qui reste : les trois conseillés tiennent ensemble (processeur et puce graphique prennent dans la même RAM sur une
 * mémoire unifiée). Voix et transcription : la meilleure note pour `language`, puis le plus gros qui tient.
 * Cerveau : un modèle local d'au moins MIN_LOCAL_BRAIN s'il tient ; sinon un cerveau cloud utilisable.
 */
export function planChoices(
  m: MachineInfo, providers: ProviderSnapshot[], clouds: CloudBrain[], agents: Agent[] = [], offered: Candidate[] = [], language = "fr",
): Plan {
  const lang = langCode(language);
  const cands = [...candidates(providers), ...offered];
  const usable = usableBrains(clouds, agents);
  const afterVad: Left = { gpu: m.modelBytes, cpu: m.cpuBytes };
  const vad = fitting(cands, "vad", m, afterVad, lang)[0];
  if (vad) use(vad, m, afterVad);
  const stt = fitting(cands, "stt", m, afterVad, lang)[0];
  const listen: Left = { ...afterVad };
  if (stt) use(stt, m, listen);

  // Cerveau dans ce qui reste : local s'il est assez grand (ou s'il n'y a pas de cloud), sinon cloud.
  const brainIn = (left: Left): { value: string; local?: Candidate } | undefined => {
    const local = fitting(cands, "llm", m, left, lang)[0];
    if (local && (local.needs.memory >= MIN_LOCAL_BRAIN || !usable.length)) return { value: valueOf(local), local };
    return usable[0] ? { value: usable[0] } : undefined;
  };
  // La voix : la mieux notée qui laisse un cerveau ; à défaut, la mieux notée seule.
  const voices = fitting(cands, "tts", m, listen, lang);
  let tts: Candidate | undefined;
  let brain: { value: string; local?: Candidate } | undefined;
  let settled = false;
  for (const v of [...voices, undefined]) {
    const left: Left = { ...listen };
    if (v) use(v, m, left);
    const b = brainIn(left);
    if (b) { tts = v; brain = b; settled = true; break; }
  }
  if (!settled) tts = voices[0];

  const recommended: Selection = {
    ...(brain ? { brain: brain.value } : {}),
    ...(stt ? { stt: valueOf(stt) } : {}),
    tts: tts ? valueOf(tts) : NO_VOICE,
  };

  const models = (role: ChoiceRole, left: Left): Choice[] => {
    const list = cands.filter((c) => c.role === ROLE_OF[role]).sort(byRank(lang));
    const fits = (c: Candidate) => !unfit(c, m, left, cands);
    // Ceux qui tiennent d'abord, chacun dans l'ordre de préférence.
    return [...list.filter(fits), ...list.filter((c) => !fits(c))].map((c): Choice => {
      const reason = unfit(c, m, left, cands);
      const value = valueOf(c);
      return {
        value, kind: c.provider ? "local" : "offered", label: c.label, ...(c.description ? { description: c.description } : {}),
        fits: !reason, ...(reason ? { reason } : {}), installed: c.installed, size: downloadSize(c, cands), device: c.needs.device,
        ...(c.languages?.[lang] ? { language: c.languages[lang] } : {}), ...(c.sample ? { sample: c.sample } : {}),
        recommended: value === recommended[role],
      };
    });
  };
  const cloudChoices: Choice[] = [
    ...clouds.map((c): Choice => {
      const agent = agents.find((a) => a.plugin === c.plugin);
      const missing = c.found === false;
      return {
        value: c.value, kind: "cloud", label: c.label, fits: !missing,
        ...(missing ? { reason: agent ? T(`${agent.program} est introuvable`, `${agent.program} cannot be found`) : T("son programme est introuvable", "its program cannot be found") } : {}),
        installed: true, size: 0, recommended: c.value === recommended.brain,
      };
    }),
    ...agents.filter((a) => a.found && !a.entries.length && a.section === "cerveau").map((a): Choice => ({
      value: ADD_PREFIX + a.plugin, kind: "cloud", label: a.label,
      description: T("Trouvé sur la machine : sera ajouté à Floppy.", "Found on this computer: it will be added to Floppy."),
      fits: true, installed: false, size: 0, recommended: ADD_PREFIX + a.plugin === recommended.brain,
    })),
  ];
  const first = (list: Choice[]) => [...list.filter((c) => c.recommended), ...list.filter((c) => !c.recommended)];
  const choices: Record<ChoiceRole, Choice[]> = {
    brain: first([...models("brain", listen), ...cloudChoices]),
    stt: first(models("stt", afterVad)),
    tts: first([...models("tts", listen), {
      value: NO_VOICE, kind: "none", label: T("Pas de voix (réponses écrites)", "No voice (written replies)"),
      fits: true, installed: true, size: 0, recommended: recommended.tts === NO_VOICE,
    }]),
  };
  return {
    machine: m, summary: machineSummary(m), language: lang, choices, recommended, cloudBrains: clouds, agents,
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
  /** Langue de l'assistant (`assistant.language`) : celle pour laquelle le conseil est calculé. */
  language(): string;
  /** Change la langue de l'assistant, par le même chemin que les Réglages (les plugins redémarrent). */
  setLanguage(lang: string): Promise<{ ok: boolean; text: Text }>;
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
  selection?: Selection;
  rows: OnboardingRow[];
  /** Phrases à montrer (ce qui vient de s'activer, descente vers un plus petit modèle, vitesse mesurée, fin). */
  notes: Text[];
  speed?: number;
  /** Floppy répond déjà (un cerveau est réglé) : le reste arrive en fond. */
  live?: boolean;
}
/** `selection` sans `done` : une installation coupée (Floppy fermé), reprise au démarrage. */
export interface OnboardingFile { done: boolean; selection?: Selection; skipped?: boolean; at?: string }

/** Comment lire la machine pour le plan. */
export interface PlanOptions { fresh?: boolean; manualBytes?: number }

const rowKey = (c: Candidate) => `${c.provider}/${c.id}`;

export class Onboarding {
  private readonly deps: OnboardingDeps;
  private plan_: Plan | undefined;
  private st: OnboardingState = { phase: "idle", rows: [], notes: [] };
  private readonly listeners = new Set<(s: OnboardingState) => void>();
  /** Écoute lancée en avance (`prepareListening`) : ce qui est demandé, et son téléchargement. */
  private listening: { keys: Set<string>; done: Promise<Candidate[] | undefined> } | undefined;
  private preparing: Promise<void> | undefined;
  /** Transcription choisie par `apply` : celle qui prend le slot, même si une autre arrive plus tard. */
  private chosenStt: string | undefined;
  /** Blocs d'écoute déjà branchés (une seule fois, une seule phrase). */
  private readonly activated = new Set<string>();

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
    if (!f || f.done || !f.selection || this.st.phase !== "idle") return false;
    await this.plan();
    return this.apply(f.selection).ok;
  }
  onState(fn: (s: OnboardingState) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { const s = { ...this.st, rows: this.st.rows.map((r) => ({ ...r })), notes: [...this.st.notes] }; for (const fn of this.listeners) fn(s); }

  /** Lit la machine et calcule les choix et le conseil. `manualBytes` : mémoire choisie à la main (rien n'a été lu). */
  async plan(opts: PlanOptions = {}): Promise<Plan> {
    let m = await this.deps.machine(opts.fresh);
    if (opts.manualBytes !== undefined) m = withManualMemory(m, opts.manualBytes);
    const agents = this.deps.agents();
    const settings = this.deps.settings();
    const snap = await this.deps.snapshot();
    this.plan_ = planChoices(m, snap, cloudBrains(settings, agents, this.deps.entries()), agents, offeredVoices(settings, snap), this.deps.language());
    return this.plan_;
  }

  /** Change la langue de l'assistant (comme dans les Réglages), puis recalcule le plan : le conseil dépend de la langue. */
  async setLanguage(lang: string, opts: PlanOptions = {}): Promise<{ ok: boolean; text: Text; plan?: Plan }> {
    const r = await this.deps.setLanguage(lang);
    if (!r.ok) return r;
    await this.deps.idle();
    return { ...r, plan: await this.plan(opts) };
  }

  /** Le candidat d'un choix du plan (modèle de bibliothèque ou voix déjà offerte). */
  private candidateOf(plan: Plan, role: ChoiceRole, value: string): Candidate | undefined {
    return plan.candidates.find((c) => c.role === ROLE_OF[role] && valueOf(c) === value);
  }

  /**
   * Écoute en avance : télécharge tout de suite le détecteur de parole et la transcription conseillée (avec leur programme), sans
   * attendre `apply`, puis règle leurs slots quand ils sont prêts. Rend la main une fois lancé (l'avancement passe par les lignes
   * de l'état). Sans effet la seconde fois. Si `apply` choisit une autre transcription, c'est elle qui prend le slot.
   */
  prepareListening(): Promise<void> {
    return (this.preparing ??= this.startListening().catch(() => { this.preparing = undefined; }));
  }

  private async startListening(): Promise<void> {
    const plan = this.plan_ ?? await this.plan();
    const stt = plan.recommended.stt ? this.candidateOf(plan, "stt", plan.recommended.stt) : undefined;
    const vad = pickVad(plan.candidates, plan.machine, plan.language);
    const models = [vad, stt].filter((c): c is Candidate => !!c);
    if (!models.length) return;
    const picks = [...programsFor(models, plan.candidates), ...models];
    for (const p of picks) if (!this.st.rows.some((r) => r.key === rowKey(p))) this.st.rows.push({ key: rowKey(p), role: p.role, label: p.label, state: "waiting" });
    this.emit();
    const done = this.install(picks).then(async (got) => {
      if (!got) return undefined;
      await this.deps.idle();
      await this.activate(got, undefined);
      return got;
    }).catch(() => undefined);
    this.listening = { keys: new Set(picks.map(rowKey)), done };
  }

  /** Installe la sélection (rend la main tout de suite ; l'avancement passe par onState). */
  apply(selection: Selection): { ok: boolean; text: Text } {
    if (this.st.phase === "installing" || this.st.phase === "testing") return { ok: false, text: T("Une installation est déjà en cours.", "An installation is already running.") };
    const unknown = { ok: false, text: T("Choix inconnu : relis la machine.", "Unknown choice: read the machine again.") };
    const plan = this.plan_;
    if (!plan) return unknown;
    const find = (role: ChoiceRole, value: string | undefined) => (value === undefined ? undefined : plan.choices[role].find((c) => c.value === value));
    const sttChoice = find("stt", selection.stt);
    const ttsChoice = selection.tts === undefined || selection.tts === NO_VOICE ? undefined : find("tts", selection.tts);
    const brainChoice = find("brain", selection.brain);
    if ((selection.stt !== undefined && !sttChoice) || (selection.tts !== undefined && selection.tts !== NO_VOICE && !ttsChoice) || (selection.brain !== undefined && !brainChoice)) return unknown;
    const sttC = sttChoice ? this.candidateOf(plan, "stt", sttChoice.value) : undefined;
    const ttsC = ttsChoice ? this.candidateOf(plan, "tts", ttsChoice.value) : undefined;
    const localC = brainChoice?.kind === "local" ? this.candidateOf(plan, "brain", brainChoice.value) : undefined;
    if ((sttChoice && !sttC) || (ttsChoice && !ttsC) || (brainChoice?.kind === "local" && !localC)) return unknown;
    // Le cerveau cloud choisi, sinon celui qui répond en attendant le cerveau local.
    const cloudValue = brainChoice?.kind === "cloud" ? brainChoice.value : localC ? plan.brain : undefined;
    const vad = sttC ? pickVad(plan.candidates, plan.machine, plan.language) : undefined;
    const models = [vad, sttC, ttsC, localC].filter((c): c is Candidate => !!c);
    const picks = [...programsFor(models, plan.candidates), ...models];
    const steps = installSteps(picks, !!cloudValue);
    const keep = this.st.phase === "idle" ? this.st : undefined;
    this.chosenStt = sttC ? rowKey(sttC) : undefined;
    // Les lignes de l'écoute en avance gardent leur avancement ; celles d'un téléchargement qu'on ne garde pas mais qui court encore restent montrées.
    const old = this.st.rows;
    const rows = steps.flat().map((p) => ({ ...(old.find((r) => this.listening?.keys.has(r.key) && r.key === rowKey(p)) ?? { key: rowKey(p), role: p.role, label: p.label, state: "waiting" as RowState }) }));
    for (const r of old) if (this.listening?.keys.has(r.key) && !rows.some((x) => x.key === r.key)) rows.push({ ...r });
    this.st = {
      phase: "installing", selection: { ...selection },
      rows,
      notes: keep ? [...keep.notes] : [],
      ...(keep?.live ? { live: true } : {}),
    };
    this.emit();
    void this.run(plan, { ...selection }, localC, cloudValue, ttsC, steps).catch((e) => {
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
  private async run(plan: Plan, selection: Selection, local: Candidate | undefined, cloudValue: string | undefined, tts: Candidate | undefined, steps: Candidate[][]): Promise<void> {
    // Noté avant les téléchargements : Floppy fermé en route, l'installation reprend au démarrage.
    this.write({ done: false, selection });
    const cloud = cloudValue ? await this.cloudBrain(plan, cloudValue) : undefined;
    // Pas de voix, ou une voix à télécharger : réponses écrites en attendant.
    if (!tts || tts.provider) await this.setSlot(ROLE_SLOT.tts, NO_VOICE);
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
      const got = await this.installStep(step);
      if (!got) { failed = true; continue; }
      await this.deps.idle();
      await this.activate(got, cloud, plan, local);
    }
    if (failed) {
      // Pas marqué fini : au prochain démarrage, l'installation reprend (les blocs déjà là sont prêts tout de suite).
      this.st.phase = "error";
      this.st.notes.push(T("Un téléchargement a échoué : Floppy marche avec le reste. Il réessaiera au prochain démarrage, ou choisis d'autres modèles.",
        "A download failed: Floppy works with the rest. It will try again at the next start, or choose other models."));
      this.emit();
      return;
    }
    this.write({ done: true, selection, at: new Date().toISOString() });
    this.st.phase = "done";
    this.st.notes.push(T("Tout est installé.", "Everything is installed."));
    this.emit();
  }

  /** Un bloc : ce que l'écoute en avance télécharge déjà n'est pas redemandé (on attend la fin de ce téléchargement). */
  private async installStep(step: Candidate[]): Promise<Candidate[] | undefined> {
    const pre = this.listening;
    const early = pre ? step.filter((p) => pre.keys.has(rowKey(p))) : [];
    const rest = step.filter((p) => !early.includes(p));
    let got: Candidate[] | undefined = [];
    if (early.length) {
      const done = await pre!.done;
      // L'écoute en avance a échoué : on réessaie ici.
      got = done && early.every((p) => done.some((g) => rowKey(g) === rowKey(p))) ? early.map((p) => done.find((g) => rowKey(g) === rowKey(p))!) : await this.install(early);
    }
    const more = got && rest.length ? await this.install(rest) : [];
    if (!got || !more) return undefined;
    const all = [...got, ...more];
    return step.map((p) => all.find((g) => rowKey(g) === rowKey(p))!);
  }

  /** Branche un bloc qui vient d'arriver (son slot) et le dit. Le cerveau local passe d'abord le test de vitesse. */
  private async activate(got: Candidate[], cloud: string | undefined, plan?: Plan, local?: Candidate): Promise<void> {
    let heard = false;
    for (const p of got) {
      if (p.role === "program") continue;
      if (p.role === "llm") { if (plan && local) await this.localBrain(plan, p, cloud); continue; }
      const key = rowKey(p);
      if (p.role === "vad" || p.role === "stt") {
        if (this.activated.has(key)) continue;
        // Une transcription que l'utilisateur n'a pas gardée ne prend pas le slot de celle qu'il a choisie.
        if (p.role === "stt" && this.chosenStt !== undefined && this.chosenStt !== key) continue;
        this.activated.add(key);
        if (p.role === "stt") heard = true;
      }
      await this.setSlot(ROLE_SLOT[p.role], `${p.source}/${p.uses}`);
    }
    if (heard) this.st.notes.push(T("Floppy t'entend : tu peux lui parler.", "Floppy hears you: you can talk to it."));
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
    language: () => kernel.assistantSettings.language,
    setLanguage: (lang) => kernel.settings.change("langue_assistant", lang, "ui"),
    borrowLlm: (value) => kernel.borrowItem<MeasuredLlm>("llm", value),
    idle: () => kernel.idle(),
  });
}
