import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

/** Source d'une fenêtre sans ses types ni son `export {}` : le contexte simulé l'exécute comme un script. */
const plain = (file: string) => stripTypeScriptTypes(readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), "utf8")).replace("export {};", "");

function input(ok = true) {
  const elements = Object.fromEntries(["prompt", "request", "send", "error", "label", "hint", "cancel"].map(id => [id, { value: "", hidden: true, disabled: false, textContent: "", focus: vi.fn(), requestSubmit: vi.fn(), events: {} as Record<string, Function>, addEventListener(name: string, fn: Function) { this.events[name] = fn; } }]));
  const events: Record<string, Function> = {};
  const host = { submit: vi.fn(async () => ok), close: vi.fn(), onLang: vi.fn(), onFocus: vi.fn() };
  const document = { documentElement: { lang: "" }, getElementById: (id: string) => elements[id], addEventListener: (name: string, fn: Function) => { events[name] = fn; } };
  runInNewContext(plain("text.ts"), { document, window: { floppyText: host } });
  return { elements, events, host, document, submit: () => elements.request.events.submit({ preventDefault() {} }) };
}

it("envoie une seule fois, ferme après succès, ignore les blancs", async () => {
  const f = input();
  await f.submit(); expect(f.host.submit).not.toHaveBeenCalled();
  f.elements.prompt.value = "Bonjour";
  const pending = f.submit(); await f.submit(); await pending;
  expect(f.host.submit).toHaveBeenCalledExactlyOnceWith("Bonjour");
  expect(f.host.close).toHaveBeenCalledOnce();
});
it("garde le brouillon et montre une erreur traduite si Floppy est indisponible", async () => {
  const f = input(false);
  f.elements.prompt.value = "Ma demande";
  await f.submit();
  expect(f.host.close).not.toHaveBeenCalled();
  expect(f.elements.prompt.value).toBe("Ma demande");
  expect(f.elements.error.hidden).toBe(false);
  f.host.onLang.mock.calls[0]![0]("en");
  expect(f.document.documentElement.lang).toBe("en");
  expect(f.elements.error.textContent).toContain("not ready");
  expect(f.elements.send.disabled).toBe(false);
});
it("Entrée envoie, Maj+Entrée et la composition restent dans le champ ; Échap ferme", () => {
  const f = input();
  const key = (extra: object) => f.events.keydown({ key: "Enter", target: f.elements.prompt, preventDefault() {}, ...extra });
  key({ shiftKey: true }); key({ isComposing: true });
  expect(f.elements.request.requestSubmit).not.toHaveBeenCalled();
  key({}); expect(f.elements.request.requestSubmit).toHaveBeenCalledOnce();
  key({ key: "Escape" }); expect(f.host.close).toHaveBeenCalledOnce();
  f.host.onFocus.mock.calls[0]![0](); expect(f.elements.prompt.focus).toHaveBeenCalledOnce();
});

it("l'avatar coupe la lecture et transmet la saisie sur son port de conversation habituel", () => {
  const source = plain("app.ts");
  let message!: Function;
  const send = vi.fn(), stopPlayback = vi.fn();
  const context = { window: { addEventListener: (_name: string, fn: Function) => { message = fn; } }, send, stopPlayback, muted: true };
  runInNewContext(source.slice(source.lastIndexOf('window.addEventListener("message"')), context);
  message({ data: { floppyTextRequest: "Bonjour" }, ports: [] });
  expect(context.muted).toBe(false);
  expect(stopPlayback).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "text", text: "Bonjour" });
  message({ data: { floppyTextRequest: "  " }, ports: [] });
  expect(send).toHaveBeenCalledOnce();
});
