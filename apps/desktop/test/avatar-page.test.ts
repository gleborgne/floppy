// @vitest-environment happy-dom
// La page de l'avatar (app-*.ts) : la façade de l'avatar et les messages de la fenêtre, avec les vrais modules.
import { afterEach, it, expect, vi } from "vitest";
import { AvatarMotion } from "../src/renderer/avatar-motion.ts";
import { createFace } from "../src/renderer/app-face.ts";
import { createSession } from "../src/renderer/app-session.ts";
import { asPort, fakePort, mountApp } from "./app-harness.ts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("un avatar sans setMouth continue de recevoir le niveau, sans erreur", async () => {
  document.body.innerHTML = '<div id="face"></div>';
  let avatar: Record<string, unknown> = {};
  const kit = createFace({ reducedMotion: false, motion: new AvatarMotion(false), session: createSession(),
    importModule: async () => ({ create: () => avatar as unknown as AvatarInstance }) });
  const setLevel = vi.fn();
  avatar = { setState() {}, setLevel };
  await kit.loadAvatar("a", "file:///a.js");
  expect(() => { kit.face.setLevel(0.4); kit.face.setMouth(0.4, 0.8); }).not.toThrow();
  expect(setLevel).toHaveBeenCalledWith(0.4);
  const setMouth = vi.fn();
  avatar = { setState() {}, setLevel, setMouth };
  await kit.loadAvatar("b", "file:///b.js");
  kit.face.setMouth(0.4, 0.8);
  expect(setMouth).toHaveBeenCalledWith(0.4, 0.8);
});

it("l'avatar coupe la lecture et transmet la saisie sur son port de conversation habituel", async () => {
  vi.useFakeTimers();
  const { app, avatar, input } = await mountApp();
  const port = fakePort();
  app.protocol.connect(asPort(port));
  const message = (data: object) => app.protocol.windowMessage({ data, ports: [] } as unknown as MessageEvent);
  message({ floppyShortcut: "mute-on" });
  expect(app.session.muted).toBe(true);
  port.postMessage.mockClear();
  message({ floppyTextRequest: "Bonjour" });
  expect(app.session.muted).toBe(false);
  expect(avatar.setSpeechGesture).toHaveBeenCalledExactlyOnceWith(null, undefined, undefined); // une seule coupure de la lecture
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ j: { type: "text", text: "Bonjour" } });
  message({ floppyTextRequest: "  " });
  expect(port.postMessage).toHaveBeenCalledOnce();
  input({ type: "state", state: "idle" });
});
