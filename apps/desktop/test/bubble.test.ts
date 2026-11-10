// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

function fixture() {
  vi.useFakeTimers();
  const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<main"), html.indexOf("</main>") + 7);
  const source = stripTypeScriptTypes(readFileSync("apps/desktop/src/renderer/app.ts", "utf8"));
  const ctx = { $: (id: string) => document.getElementById(id), document, clearTimeout, setTimeout,
    requestAnimationFrame: (fn: Function) => fn(), performance, hideTimer: 0, replyText: "", life: {},
    face: { setState() {}, setAttention() {} }, host: null, pttOn: false, muted: false,
    send() {}, stopPlayback() {}, L: (key: string) => key };
  runInNewContext(source.slice(source.indexOf("// ------------------------------------------------------------------ bulle"), source.indexOf("// Fenêtre transparente"))
    + source.slice(source.indexOf("/** Une carte."), source.indexOf("// ------------------------------------------------------------------ voix (lecture)"))
    + source.slice(source.indexOf("const approvals ="), source.indexOf("function connect("))
    + "\nglobalThis.input = onMessage;", ctx);
  return { input: (ctx as typeof ctx & { input(m: object): void }).input,
    bubble: document.getElementById("bubble")!, cards: document.getElementById("cards")! };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("conserve le texte de la notification pendant toute sa lecture, même au-delà de 12 secondes", () => {
  const f = fixture();
  const text = "L'agent a terminé de restructurer les notes. Il attend votre validation avant de publier les changements.";
  f.input({ type: "notify", text, important: true });
  f.input({ type: "state", state: "speaking" });
  vi.advanceTimersByTime(20000);
  expect(f.cards.textContent).toContain(text);
  expect(f.bubble.classList.contains("hide")).toBe(false);
  f.input({ type: "state", state: "idle" });
  vi.advanceTimersByTime(1000);
  expect(f.cards.textContent).toContain(text);
  vi.advanceTimersByTime(10000);
  expect(f.bubble.classList.contains("hide")).toBe(true);
});

it("ne laisse pas de coquille vide quand la dernière carte est fermée", () => {
  const f = fixture();
  f.input({ type: "notify", text: "Une notification.", important: true });
  f.input({ type: "state", state: "speaking" });
  f.cards.querySelector<HTMLElement>(".card")!.click();
  expect(f.cards.children).toHaveLength(0);
  expect(f.bubble.classList.contains("hide")).toBe(true);
});

it("garde une notification au retour en écoute puis au repos avant de la fermer", () => {
  const f = fixture();
  f.input({ type: "notify", text: "Merci de valider les notes.", important: true });
  f.input({ type: "state", state: "speaking" });
  vi.advanceTimersByTime(15000);
  f.input({ type: "state", state: "listening" });
  vi.advanceTimersByTime(5000);
  expect(f.cards.textContent).toContain("Merci de valider les notes.");
  f.input({ type: "state", state: "idle" });
  vi.advanceTimersByTime(9000);
  expect(f.bubble.classList.contains("hide")).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(f.bubble.classList.contains("hide")).toBe(true);
});
