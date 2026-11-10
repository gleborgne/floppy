// @vitest-environment happy-dom
// Page de l'avatar : les noms anglais du protocole (documents, réglages d'affichage) et la frontière avec les outils
// `placer_avatar` / `afficher_carte`, dont les arguments restent français jusqu'au lot des outils.
import { afterEach, it, expect, vi } from "vitest";
import { asPort, fakePort, mountApp } from "./app-harness.ts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const hostStub = () => ({
  place: vi.fn(async () => ({ ok: true, text: { fr: "Avatar placé.", en: "Avatar moved." } })),
  openDocument: vi.fn(), updateDocuments: vi.fn(), approvalClosed: vi.fn(),
});

it("`document` et `documents` : titre et liste arrivent à la fenêtre sous leurs noms anglais", async () => {
  const host = hostStub();
  const f = await mountApp(host);
  const entries = [{ id: "a", title: "Un", date: "2026-11-06T08:00:00.000Z", tags: ["veille"] }];
  f.input({ type: "document", id: "a", title: "Un", markdown: "m", entries });
  expect(host.openDocument).toHaveBeenCalledWith({ type: "document", id: "a", title: "Un", markdown: "m", entries });
  f.input({ type: "documents", entries: [] });
  expect(host.updateDocuments).toHaveBeenCalledWith([]);
});

it("`placer_avatar` : les arguments de l'outil (français) sont traduits en { corner, screen, target } pour la fenêtre", async () => {
  vi.useFakeTimers();
  const host = hostStub();
  const f = await mountApp(host);
  const port = fakePort();
  f.app.protocol.connect(asPort(port));
  port.postMessage.mockClear();
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c1", name: "placer_avatar", args: { coin: "haut_gauche", ecran: 2, cible: "fenetre" } } as never);
  expect(host.place).toHaveBeenLastCalledWith({ corner: "top_left", screen: 2, target: "window" });
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c2", name: "placer_avatar", args: {} } as never);
  expect(host.place).toHaveBeenLastCalledWith({ corner: undefined, screen: undefined, target: "screen" });
  expect(port.postMessage).toHaveBeenCalledWith({ j: expect.objectContaining({ type: "tool.result", callId: "c1", ok: true }) });
});

it("réglages d'affichage : `bubble` et `shortcuts.talk` (message de la fenêtre)", async () => {
  vi.useFakeTimers();
  const f = await mountApp(hostStub());
  f.app.protocol.windowMessage({ data: { floppyDisplay: { bubble: false, shortcuts: { talk: "Ctrl+Alt+G" }, lang: "fr" } }, ports: [] } as unknown as MessageEvent);
  f.input({ type: "reply.delta", text: "bonjour" } as never);
  expect(document.body.classList.contains("nobubble")).toBe(true);
  f.app.protocol.windowMessage({ data: { floppyDisplay: { bubble: true, lang: "fr" } }, ports: [] } as unknown as MessageEvent);
  expect(document.body.classList.contains("nobubble")).toBe(false);
});
