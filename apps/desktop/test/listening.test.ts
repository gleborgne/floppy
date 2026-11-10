// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { asPort, fakePort, mountApp } from "./app-harness.ts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("garde le retour visuel tant que le noyau reste en écoute, même après une transcription", async () => {
  vi.useFakeTimers();
  const { input } = await mountApp();
  const listen = document.getElementById("listen")!;
  input({ type: "state", state: "listening" });
  input({ type: "transcript", text: "Floppy" });
  expect(listen.hidden).toBe(false);
  input({ type: "state", state: "thinking" });
  expect(listen.hidden).toBe(true);
});
it("la croix arrête l'écoute active sans demander le mode muet", async () => {
  vi.useFakeTimers();
  const { app, avatar } = await mountApp();
  const port = fakePort();
  app.protocol.connect(asPort(port));
  port.postMessage.mockClear();
  document.getElementById("stopListening")!.click();
  expect(port.postMessage).toHaveBeenCalledWith({ j: { type: "listen.stop" } });
  expect(port.postMessage).not.toHaveBeenCalledWith({ j: { type: "mute", on: true } });
  expect(avatar.setSpeechGesture).not.toHaveBeenCalled(); // la lecture n'est pas coupée
});
it("garde l'indicateur et son bouton hors du texte défilant, avec un nom accessible", () => {
  const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7);
  expect(document.querySelector("#listen")?.parentElement?.id).toBe("bubble");
  expect(document.querySelector("#scroll #listen")).toBeNull();
  expect(document.querySelector("#listen button")?.getAttribute("aria-label")).toBe("Arrêter l'écoute");
});
