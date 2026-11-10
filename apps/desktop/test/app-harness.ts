// Page de l'avatar complète (les vrais modules, branchés comme app.ts) dans happy-dom, avec un avatar simulé et un port simulé.
// Les fichiers qui l'utilisent déclarent `// @vitest-environment happy-dom` et gèrent leurs minuteries (vi.useFakeTimers).
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { createApp } from "../src/renderer/app-wire.ts";

/** Avatar simulé : toutes les méthodes du contrat, comptées. */
export function fakeAvatar() {
  return { setState: vi.fn(), setEmotion: vi.fn(), setLevel: vi.fn(), setMouth: vi.fn(), setMood: vi.fn(), lookAt: vi.fn(), setHearing: vi.fn(),
    cue: vi.fn(), setAttention: vi.fn(), setSpeechTime: vi.fn(), setSpeechGesture: vi.fn(), destroy: vi.fn() };
}
/** Port simulé : ce que le noyau recevrait est dans `postMessage`. */
export function fakePort() {
  return { onmessage: null as ((e: unknown) => void) | null, close: vi.fn(), start: vi.fn(), postMessage: vi.fn() };
}
export const asPort = (p: ReturnType<typeof fakePort>) => p as unknown as MessagePort;

/** Monte index.html, assemble la page et charge l'avatar simulé (ses compteurs repartent de zéro). */
export async function mountApp(host?: object) {
  const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<main"), html.indexOf("</main>") + 7);
  const avatar = fakeAvatar();
  const app = createApp({ importModule: async () => ({ create: () => avatar }), ...(host ? { host: host as never } : {}) });
  await app.loadAvatar("test", "file:///test.js");
  for (const fn of Object.values(avatar)) fn.mockClear();
  /** Message du noyau reçu par la page. */
  const input = (m: object) => app.protocol.onMessage(m as never);
  return { app, avatar, input, bubble: document.getElementById("bubble")!, cards: document.getElementById("cards")! };
}
