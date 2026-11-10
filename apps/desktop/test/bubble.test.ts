// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { mountApp } from "./app-harness.ts";

async function fixture() {
  vi.useFakeTimers();
  const { input, bubble, cards } = await mountApp();
  return { input, bubble, cards };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("conserve le texte de la notification pendant toute sa lecture, même au-delà de 12 secondes", async () => {
  const f = await fixture();
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

it("ne laisse pas de coquille vide quand la dernière carte est fermée", async () => {
  const f = await fixture();
  f.input({ type: "notify", text: "Une notification.", important: true });
  f.input({ type: "state", state: "speaking" });
  f.cards.querySelector<HTMLElement>(".card")!.click();
  expect(f.cards.children).toHaveLength(0);
  expect(f.bubble.classList.contains("hide")).toBe(true);
});

it("garde une notification au retour en écoute puis au repos avant de la fermer", async () => {
  const f = await fixture();
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
