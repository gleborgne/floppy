// Un robot actif : surveille le daemon (toutes les 10 s), se branche comme corps dans le hub quand il répond,
// se débranche quand il ne répond plus, traduit états / émotions / outils corps en mouvements.
import { T, TextError, tr, type BodyHub, type Text } from "@floppy/core";
import type { BodyToKernel, BodyToolDecl, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import { DaemonClient, type DaemonStatus } from "./daemon.ts";
import { DIRECTIONS, EMOTION_GESTURE, GESTURES, STATE_GESTURE, toGoto } from "./gestures.ts";

export interface RobotValues {
  name: string;
  url: string;
  mic: "robot" | "pc";
  voice: string;
  approve: boolean;
}

export type LinkState = "connecting" | "up" | "down";

export interface LinkDeps {
  hub: BodyHub;
  log: (level: "debug" | "info" | "warn" | "error", text: string) => void;
  changed: () => void;
  retryMs: number;
  /** Multiplie les attentes entre images-clés (1 = vitesse réelle ; les tests mettent presque 0). */
  pace: number;
}

/**
 * L'audio du robot (micro et haut-parleur) passe par GStreamer / WebRTC, pas par l'API REST du daemon :
 * ce pont n'existe pas encore. Sans lui, pas de capacité `voice` (le hub enverrait la voix dans le vide).
 * La voix du PC et le micro du PC restent ceux de l'avatar.
 */
export const AUDIO_BRIDGE = false;

export function capabilitiesFor(v: RobotValues, st?: DaemonStatus, audioBridge = AUDIO_BRIDGE): Capability[] {
  const caps: Capability[] = ["emotion", "gesture"];
  if (v.approve) caps.push("approval");
  const sim = !!(st?.simulation_enabled || st?.mockup_sim_enabled);
  if (audioBridge && v.mic === "robot" && !sim && !st?.no_media) caps.push("voice");
  return caps;
}

const dirSchema = { type: "object", properties: { direction: { type: "string", enum: ["gauche", "droite", "haut", "bas", "devant"] } }, required: ["direction"] };
const none = { type: "object", properties: {} };

export const TOOLS: (BodyToolDecl & { gesture?: string })[] = [
  // Niveau « read » : un mouvement de tête est sans risque, pas besoin d'un accord à chaque hochement.
  { name: "hocher_tete", description: "Reachy hoche la tête (oui).", inputSchema: none, level: "read", gesture: "nod" },
  { name: "secouer_tete", description: "Reachy secoue la tête (non).", inputSchema: none, level: "read", gesture: "shake" },
  { name: "regarder", description: "Reachy tourne la tête vers une direction.", inputSchema: dirSchema, level: "read" },
  { name: "content", description: "Reachy remue les antennes de joie.", inputSchema: none, level: "read", gesture: "happy" },
  { name: "danser", description: "Reachy danse quelques secondes.", inputSchema: none, level: "read", gesture: "dance" },
];

export class RobotLink {
  readonly id: string;
  readonly values: RobotValues;
  state: LinkState = "connecting";
  lastError = "";
  /** Langue de l'assistant (donnée par le noyau dans « welcome ») : réponses des outils du robot. */
  private lang = "fr";
  status: DaemonStatus | undefined;
  caps: Capability[] = [];
  readonly client: DaemonClient;
  private readonly deps: LinkDeps;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private msgFn: ((m: BodyToKernel) => void) | undefined;
  private closeFns: (() => void)[] = [];
  private attached = false;
  // Mouvements : une séquence à la fois ; une nouvelle remplace l'ancienne.
  private gen = 0;
  private active = 0;
  private chain: Promise<void> = Promise.resolve();
  private moveWarned = false;

  constructor(id: string, values: RobotValues, deps: LinkDeps) {
    this.id = id;
    this.values = values;
    this.deps = deps;
    this.client = new DaemonClient(values.url);
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.gen++;
    this.detach();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const st = await this.client.status();
      if (this.stopped) return;
      if (st.state && st.state !== "running") throw new TextError(T(`le daemon n'est pas prêt (${st.state})`, `the daemon is not ready (${st.state})`));
      this.status = st;
      this.caps = capabilitiesFor(this.values, st);
      if (!this.attached) {
        this.attach();
        this.deps.log("info", `Reachy « ${this.values.name} » joignable (${this.client.base})`);
      }
      this.setState("up", "");
    } catch (e) {
      if (this.stopped) return;
      const text = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      // Une seule ligne par panne : pas de journal à chaque essai.
      if (this.state !== "down") this.deps.log("warn", `Reachy « ${this.values.name} » injoignable (${this.client.base}) : ${text}. Nouvel essai toutes les ${Math.round(this.deps.retryMs / 1000)} s.`);
      this.detach();
      this.setState("down", text);
    }
    if (!this.stopped) { this.timer = setTimeout(() => void this.tick(), this.deps.retryMs); this.timer.unref?.(); }
  }

  private setState(s: LinkState, err: string): void {
    const changed = s !== this.state || err !== this.lastError;
    this.state = s;
    this.lastError = err;
    if (changed) this.deps.changed();
  }

  // ------------------------------------------------------------------ branchement au hub
  private attach(): void {
    const transport: BodyTransport = {
      send: (m) => this.fromKernel(m),
      sendAudio: () => { /* pas de pont audio (voir AUDIO_BRIDGE) */ },
      onMessage: (fn) => { this.msgFn = fn; },
      onAudio: () => { /* idem */ },
      onClose: (fn) => { this.closeFns.push(fn); },
      close: () => { this.detach(); },
    };
    this.attached = true;
    this.deps.hub.attach(transport, { id: `reachy-${this.id}`, name: this.values.name, managed: true });
    this.msgFn?.({
      type: "hello", id: `reachy-${this.id}`, name: this.values.name, version: "0.1.0", managed: true,
      capabilities: this.caps,
      tools: TOOLS.map(({ gesture: _g, ...d }) => d),
    });
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const fns = this.closeFns;
    this.closeFns = [];
    this.msgFn = undefined;
    for (const fn of fns) { try { fn(); } catch { /* rien */ } }
  }

  // ------------------------------------------------------------------ noyau → robot
  private fromKernel(m: KernelToBody): void {
    switch (m.type) {
      case "emotion": {
        // Émotion légère : geste plus discret, et il ne coupe pas un geste en cours. Forte : la danse pour la joie.
        let g = EMOTION_GESTURE[m.emotion] ?? "rest";
        const i = m.intensity ?? 1;
        if (i < 0.6 && g === "dance") g = "happy";
        if (i > 1.1 && (m.emotion === "joy" || m.emotion === "laugh")) g = "dance";
        void this.play(g, i < 0.6 ? "low" : "high");
        break;
      }
      // Signaux de conversation : hocher la tête quand on lui parle, se redresser au réveil ou quand on le coupe.
      case "cue": void this.play(m.cue === "nod" ? "nod_small" : "perk", m.cue === "wake" ? "high" : "low"); break;
      case "state": {
        const g = STATE_GESTURE[m.state];
        if (g) void this.play(g, "low");
        break;
      }
      case "approval.request": void this.play("tilt", "high"); break;
      case "error": void this.play("droop", "high"); break;
      case "tool.call": void this.runTool(m.callId, m.name, m.args); break;
      case "welcome": this.lang = m.assistant?.language ?? "fr"; break;
      default: break;
    }
  }

  private async runTool(callId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const reply = (ok: boolean, text: Text) => this.msgFn?.({ type: "tool.result", callId, ok, text: tr(text, this.lang) });
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return reply(false, T(`Outil inconnu : ${name}.`, `Unknown tool: ${name}.`));
    let gesture = tool.gesture;
    if (name === "regarder") {
      gesture = DIRECTIONS[String(args.direction ?? "").toLowerCase()];
      if (!gesture) return reply(false, T("Direction inconnue : gauche, droite, haut, bas ou devant.", "Unknown direction: left, right, up, down or front."));
    }
    const ok = await this.play(gesture ?? "rest", "high");
    reply(ok, ok ? T("Fait.", "Done.") : T("Le robot n'a pas bougé (daemon injoignable).", "The robot did not move (daemon unreachable)."));
  }

  // ------------------------------------------------------------------ mouvements
  /** Joue un geste. `low` : ignoré si un mouvement est déjà en cours. Renvoie false si le daemon refuse. */
  play(name: string, prio: "low" | "high"): Promise<boolean> {
    const frames = GESTURES[name];
    if (!frames) return Promise.resolve(false);
    if (prio === "low" && this.active > 0) return Promise.resolve(true);
    const my = ++this.gen;
    this.active++;
    const prev = this.chain;
    const run = (async () => {
      await prev;
      let ok = true;
      for (const f of frames) {
        if (this.gen !== my || this.stopped) break;
        try {
          await this.client.goto(toGoto(f));
          this.moveWarned = false;
        } catch (e) {
          ok = false;
          if (!this.moveWarned) { this.moveWarned = true; this.deps.log("warn", `mouvement refusé par le daemon : ${e instanceof Error ? e.message : String(e)}`); }
          break;
        }
        await new Promise((r) => setTimeout(r, f.d * 1000 * this.deps.pace));
      }
      return ok;
    })();
    this.chain = run.then(() => undefined, () => undefined);
    return run.finally(() => { this.active--; });
  }
}
