// Pilule de dictée : retour visuel pendant que Floppy écoute et tape.
const api = window.floppyDictation;
const N = 11;
// Éléments de la page : ils existent dans dictation.html (pas de repli).
const bars = document.getElementById("bars") as HTMLElement;
const dot = document.getElementById("dot") as HTMLElement;
const pill = document.getElementById("pill") as HTMLElement;
for (let i = 0; i < N; i++) bars.appendChild(document.createElement("i"));
const items = [...bars.children] as HTMLElement[];
// Forme en cloche : le centre bouge plus que les bords ; un peu de hasard pour que ça vive.
const shape = items.map((_, i) => 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2) * 0.6);
let level = 0;
let flashTimer = 0;

api.onLevel((v) => { level = Math.max(v, level * 0.7); });
api.onTyped(() => {
  dot.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => dot.classList.remove("flash"), 180);
});
api.onState((s) => {
  pill.classList.toggle("finishing", s === "finishing");
  if (s === "listening") level = 0;
});
(document.getElementById("stop") as HTMLElement).addEventListener("click", () => api.stop());
// Textes (fr / en) : langue de l'interface, envoyée par l'app.
const TXT: Record<string, { title: string; stopTip: string; stop: string }> = {
  fr: { title: "Floppy — Dictée", stopTip: "Arrêter la dictée (Ctrl+Alt+D)", stop: "Arrêter la dictée" },
  en: { title: "Floppy — Dictation", stopTip: "Stop dictation (Ctrl+Alt+D)", stop: "Stop dictation" },
};
api.onLang?.((l) => {
  const t = TXT[l];
  if (!t) return;
  // Sur Mac, Ctrl+Alt s'écrit ⌃⌥ (la touche Alt s'appelle Option).
  const keys = (s: string) => (/Mac/i.test(navigator.platform || navigator.userAgent) ? s.replaceAll("Ctrl+Alt+", "⌃⌥") : s);
  document.documentElement.lang = l;
  document.title = t.title;
  const b = document.getElementById("stop") as HTMLElement;
  b.title = keys(t.stopTip);
  b.setAttribute("aria-label", t.stop);
});

function frame() {
  if (!pill.classList.contains("finishing")) {
    items.forEach((el, i) => {
      const h = 4 + Math.min(1, level) * 22 * (shape[i] ?? 1) * (0.75 + Math.random() * 0.5);
      el.style.height = `${h.toFixed(1)}px`;
      el.style.opacity = (0.45 + Math.min(1, level) * 0.55).toFixed(2);
      el.style.animationDelay = "";
    });
  } else items.forEach((el, i) => { el.style.height = ""; el.style.opacity = ""; el.style.animationDelay = `${i * 70}ms`; });
  level *= 0.92;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Module (pas de nom global partagé entre les pages).
export {};
