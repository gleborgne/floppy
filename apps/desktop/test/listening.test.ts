// @vitest-environment happy-dom
import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

function fixture() {
  const source = stripTypeScriptTypes(readFileSync("apps/desktop/src/renderer/app.ts", "utf8"));
  const elements = Object.fromEntries(["bubble", "scroll", "listen", "stopListening", "you", "reply", "cards"].map(id => [id, {
    hidden: true, textContent: "", children: [], classList: { remove: vi.fn(), add: vi.fn() },
    addEventListener: vi.fn(), querySelector: () => null, querySelectorAll: () => [], append() {},
  }]));
  const send = vi.fn();
  const ctx = { $: (id: string) => elements[id], clearTimeout, setTimeout, requestAnimationFrame: (fn: Function) => fn(),
    performance, hideTimer: 0, replyText: "", life: {}, face: { setState() {}, setAttention() {} }, host: null, pttOn: false, muted: false,
    send, stopPlayback: vi.fn(), L: () => "Toi", document: { createElement: () => ({}), createTextNode: () => ({}) } };
  const code = source.slice(source.indexOf("// ------------------------------------------------------------------ bulle"), source.indexOf("// Fenêtre transparente"))
    + source.slice(source.indexOf("const approvals ="), source.indexOf("function connect("))
    + "\nglobalThis.input = onMessage;";
  runInNewContext(code, ctx);
  return { elements, send, stopPlayback: ctx.stopPlayback, input: (ctx as typeof ctx & { input(m: object): void }).input };
}
it("garde le retour visuel tant que le noyau reste en écoute, même après une transcription", () => {
  const f = fixture();
  f.input({ type: "state", state: "listening" });
  f.input({ type: "transcript", text: "Floppy" });
  expect(f.elements.listen.hidden).toBe(false);
  f.input({ type: "state", state: "thinking" });
  expect(f.elements.listen.hidden).toBe(true);
});
it("la croix arrête l'écoute active sans demander le mode muet", () => {
  const f = fixture();
  const click = f.elements.stopListening.addEventListener.mock.calls.find(([event]) => event === "click")?.[1];
  expect(click).toBeTypeOf("function");
  click();
  expect(f.send).toHaveBeenCalledWith({ type: "listen.stop" });
  expect(f.send).not.toHaveBeenCalledWith({ type: "mute", on: true });
  expect(f.stopPlayback).not.toHaveBeenCalled();
});
it("garde l'indicateur et son bouton hors du texte défilant, avec un nom accessible", () => {
  const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7);
  expect(document.querySelector("#listen")?.parentElement?.id).toBe("bubble");
  expect(document.querySelector("#scroll #listen")).toBeNull();
  expect(document.querySelector("#listen button")?.getAttribute("aria-label")).toBe("Arrêter l'écoute");
});
