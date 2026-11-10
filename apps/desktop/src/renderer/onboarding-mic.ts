// Fenêtre « Bienvenue » : l'essai du micro. Barres de niveau (getUserMedia + AnalyserNode) ; rien n'est enregistré ni envoyé :
// le son sert seulement à mesurer le niveau, et le flux est arrêté en quittant l'écran.
import { barLevels, micLevel, MIC_HEARD } from "./onboarding-view.ts";

export type MicStatus = "idle" | "starting" | "listening" | "heard" | "denied" | "none";
export const BARS = 12;

export const mic: { status: MicStatus } = { status: "idle" };
let stopper: (() => void) | null = null;
let token = 0;

/** Dessine le niveau dans les barres de la page (`.mic-bars i`), sans redessiner la page. */
function paint(level: number): void {
  const bars = document.querySelectorAll<HTMLElement>(".mic-bars i");
  const heights = barLevels(level, bars.length);
  bars.forEach((bar, i) => { bar.style.transform = `scaleY(${heights[i]!.toFixed(2)})`; });
}

/** Ouvre le micro et mesure le niveau ; `changed` est appelé quand l'état change (entendu, refusé…). Sans effet si déjà ouvert. */
export function startMic(changed: () => void): void {
  if (stopper) return;
  const mine = ++token;
  const set = (status: MicStatus) => { if (mic.status !== status) { mic.status = status; changed(); } };
  set("starting");
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) { set("none"); return; }
  devices.getUserMedia({ audio: true }).then((stream) => {
    // L'écran a été quitté pendant que le navigateur demandait l'accès : on referme tout de suite.
    if (mine !== token) { for (const tr of stream.getTracks()) tr.stop(); return; }
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    document.documentElement.classList.toggle("calm", reduced);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      const level = micLevel(data);
      paint(level);
      if (level > MIC_HEARD) set("heard");
    };
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Mouvement réduit : quelques mises à jour par seconde, sans fondu.
    if (reduced) timer = setInterval(tick, 250);
    else { const loop = () => { tick(); frame = requestAnimationFrame(loop); }; frame = requestAnimationFrame(loop); }
    set("listening");
    stopper = () => {
      cancelAnimationFrame(frame);
      if (timer) clearInterval(timer);
      for (const tr of stream.getTracks()) tr.stop();
      void ctx.close().catch(() => {});
    };
  }, (err: unknown) => {
    if (mine !== token) return;
    set((err as { name?: string })?.name === "NotFoundError" ? "none" : "denied");
  });
}

/** Ferme le micro (on quitte l'écran). */
export function stopMic(): void {
  token++;
  stopper?.();
  stopper = null;
  mic.status = "idle";
}
