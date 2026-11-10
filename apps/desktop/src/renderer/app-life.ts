// Vie (commune à tous les avatars) : ce qui rend Floppy vivant sans le noyau — réactions quand on le touche, petites
// manies quand il s'ennuie, regard qui suit la souris. L'émotion du noyau reste prioritaire : une réaction locale est
// brève, puis l'émotion du noyau revient si elle est encore en cours. Le choix d'une manie est pur (quirks.ts).
import { $ } from "./app-dom.ts";
import { chooseQuirk } from "./quirks.ts";
import type { Face } from "./app-face.ts";
import type { SessionView } from "./app-session.ts";

export interface LifeDeps {
  face: Pick<Face, "setEmotion" | "cue" | "lookAt">;
  /** Lecture seule : l'état de Floppy (il dort : on le dérange sans le réveiller ; au repos : manies). */
  session: Pick<SessionView, "state">;
  /** Dernière humeur du noyau (propriété de la façade de l'avatar). */
  mood(): { valence: number; energy: number } | null;
  host?: FloppyHostApi;
}

const POKE_REACTIONS: [string, number, number][] = [["laugh", 1300, 1], ["shy", 1500, 1], ["wink", 900, 1], ["surprised", 800, 0.8], ["joy", 1200, 0.9], ["love", 1400, 0.8], ["mischief", 1100, 1]];

/** Propriétaire de la vie : dernière émotion du noyau, activité, manies, clics. Branche aussi la souris et la tête. */
export function createLife(deps: LifeDeps) {
  const { face, session, host } = deps;
  const life: { kernel: { name: string; intensity: number | undefined; until: number; at: number }; activeAt: number; nextQuirk: number; pokes: number[]; lastPoke: string; flashTimer: number } = {
    kernel: { name: "neutral", intensity: undefined, until: 0, at: 0 }, // dernière émotion du noyau
    activeAt: performance.now(),  // dernière activité (état autre que repos, clic, émotion du noyau)
    nextQuirk: performance.now() + 20000,
    pokes: [],
    lastPoke: "",
    flashTimer: 0,
  };
  /** Émotion locale brève ; ensuite, l'émotion du noyau revient si elle est encore valable. */
  function flash(name: string, ms: number, intensity: number): void {
    face.setEmotion(name, ms, intensity);
    clearTimeout(life.flashTimer);
    const at = life.kernel.at;
    life.flashTimer = setTimeout(() => {
      const k = life.kernel;
      if (k.at !== at || k.name === "neutral") return;
      const left = k.until ? k.until - performance.now() : 0;
      if (!k.until || left > 0) face.setEmotion(k.name, k.until ? left : undefined, k.intensity);
    }, ms);
  }
  /** Un clic sur la tête : il rit, rougit, fait un clin d'œil… et finit par se fâcher si on insiste. */
  function poke() {
    const now = performance.now();
    life.activeAt = now;
    life.pokes = life.pokes.filter((t) => now - t < 4000);
    life.pokes.push(now);
    face.cue("poke");
    const n = life.pokes.length;
    if (session.state === "sleep") return flash("annoyed", 900, 0.5); // on le dérange : il grogne, sans se réveiller
    if (n >= 7) return flash("angry", 1600, 0.9);
    if (n >= 4) return flash("annoyed", 1400, 1);
    const choices = POKE_REACTIONS.filter(([name]) => name !== life.lastPoke);
    const [name, ms, i] = choices[Math.floor(Math.random() * choices.length)] ?? ["joy", 1200, 0.9];
    life.lastPoke = name;
    flash(name, ms, i);
  }
  /** Petites manies au repos : un regard ailleurs, un bâillement s'il est fatigué, un air malicieux… */
  function quirk() {
    const now = performance.now();
    const mood = deps.mood();
    // Le choix (humeur, émotion récente du noyau) est dans quirks.ts ; ici on l'exécute seulement.
    const q = chooseQuirk({ valence: mood?.valence ?? 0.2, energy: mood?.energy ?? 0.6, aloneMs: now - life.activeAt,
      kernelEmotion: life.kernel.name, kernelAgoMs: now - life.kernel.at, random: Math.random });
    if (q.kind === "flash") { flash(q.name, q.ms, q.intensity); if (q.cue) face.cue(q.cue); }
    else if (q.kind === "look") face.lookAt(q.x, q.y);
    else if (q.kind === "cue") face.cue(q.name);
  }
  setInterval(() => {
    const now = performance.now();
    if (session.state !== "idle") { life.activeAt = now; return; }
    if (now < life.nextQuirk || now - life.kernel.at < 10000 || now - life.activeAt < 15000) return;
    life.nextQuirk = now + 15000 + Math.random() * 25000;
    if (!document.hidden) quirk();
  }, 1000);
  /** Position de la souris (px dans la fenêtre) → regard de l'avatar (-1..1 autour du visage). */
  function lookAtPoint(x: number, y: number): void {
    const r = $("faceWrap")?.getBoundingClientRect();
    if (!r?.width) return;
    const dx = (x - (r.left + r.width / 2)) / (r.width * 1.2);
    const dy = (y - (r.top + r.height * 0.45)) / (r.height * 1.4);
    face.lookAt(Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy)));
  }
  // Déplacer à la main, ou toucher : un appui sans bouger (moins de 5 px) est un clic sur la tête.
  {
    const wrap = $("faceWrap");
    let press: { x: number; y: number; moved: boolean } | null = null;
    const stop = (e: PointerEvent, click: boolean) => {
      if (!press) return;
      if (press.moved) host?.drag?.("end");
      else if (click) poke();
      press = null;
      wrap.classList.remove("dragging");
      try { wrap.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    };
    wrap?.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      press = { x: e.screenX, y: e.screenY, moved: false };
      wrap.setPointerCapture(e.pointerId);
    });
    wrap?.addEventListener("pointermove", (e) => {
      if (!press) return;
      if (!press.moved && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
        press.moved = true;
        wrap.classList.add("dragging");
        host?.drag?.("start");
      }
      if (press.moved) host?.drag?.("move");
    });
    wrap?.addEventListener("pointerup", (e) => stop(e, true));
    wrap?.addEventListener("pointercancel", (e) => stop(e, false));
  }
  // Fenêtre transparente : les clics traversent les zones vides ; la tête et la bulle restent cliquables.
  let interactive: boolean | null = null;
  window.addEventListener("mousemove", (e) => {
    lookAtPoint(e.clientX, e.clientY);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hit = !!el?.closest("#bubble:not(.hide), #faceWrap");
    if (hit !== interactive) { interactive = hit; host?.setInteractive(hit); }
  });
  document.addEventListener("mouseleave", () => { if (interactive !== false) { interactive = false; host?.setInteractive(false); } });
  return {
    /** Activité (état autre que repos) : repousse les manies. */
    touch(): void { life.activeAt = performance.now(); },
    /** Émotion décidée par le noyau : prioritaire, elle revient après une réaction locale. */
    kernelEmotion(emotion: string, intensity: number | undefined, ms: number | undefined): void {
      clearTimeout(life.flashTimer);
      life.kernel = { name: emotion, intensity, until: ms ? performance.now() + ms : 0, at: performance.now() };
      face.setEmotion(emotion, ms, intensity);
    },
    /** Coupure de la parole : plus d'émotion du noyau en cours, visage neutre. */
    resetKernelEmotion(): void {
      clearTimeout(life.flashTimer);
      life.kernel = { name: "neutral", intensity: 1, until: 0, at: performance.now() };
      face.setEmotion("neutral");
    },
    lookAtPoint,
  };
}
export type Life = ReturnType<typeof createLife>;
