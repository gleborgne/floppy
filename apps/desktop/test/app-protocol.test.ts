// @vitest-environment happy-dom
// Page de l'avatar : les noms anglais du protocole (documents, réglages d'affichage) et les outils de l'avatar
// `place_avatar` / `show_card` (arguments et valeurs en anglais, transmis tels quels à la fenêtre).
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
  const entries = [{ id: "a", title: "Un", date: "2026-11-06T08:00:00.000Z", tags: ["watch"] }];
  f.input({ type: "document", id: "a", title: "Un", markdown: "m", entries });
  expect(host.openDocument).toHaveBeenCalledWith({ type: "document", id: "a", title: "Un", markdown: "m", entries });
  f.input({ type: "documents", entries: [] });
  expect(host.updateDocuments).toHaveBeenCalledWith([]);
});

it("`place_avatar` : les arguments de l'outil { corner, screen, target } arrivent à la fenêtre ; valeurs sûres par défaut", async () => {
  vi.useFakeTimers();
  const host = hostStub();
  const f = await mountApp(host);
  const port = fakePort();
  f.app.protocol.connect(asPort(port));
  port.postMessage.mockClear();
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c1", name: "place_avatar", args: { corner: "top_left", screen: 2, target: "window" } } as never);
  expect(host.place).toHaveBeenLastCalledWith({ corner: "top_left", screen: 2, target: "window" });
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c2", name: "place_avatar", args: {} } as never);
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

// ------------------------------------------------------------------ conversation et liste de choix
const chatHost = () => ({ ...hostStub(), chat: vi.fn(), openChat: vi.fn(), activity: vi.fn(), setState: vi.fn(), setInteractive: vi.fn() });
const sent = (port: ReturnType<typeof fakePort>) => port.postMessage.mock.calls.map((c) => (c[0] as { j: { type: string } }).j);
const options = [{ id: "a", label: "Perso", detail: "Calendrier privé" }, { id: "b", label: "Travail" }];

async function connected() {
  vi.useFakeTimers();
  const host = chatHost();
  const f = await mountApp(host);
  const port = fakePort();
  f.app.protocol.connect(asPort(port));
  host.chat.mockClear(); port.postMessage.mockClear();
  return { ...f, host, port };
}

it("annonce la capacité « choice » au noyau", async () => {
  vi.useFakeTimers();
  const f = await mountApp(chatHost());
  const port = fakePort();
  f.app.protocol.connect(asPort(port));
  expect(sent(port)[0]).toMatchObject({ type: "hello", capabilities: expect.arrayContaining(["choice", "approval"]) });
});

it("relaie à la fenêtre Conversation ce que le noyau dit (transcription finale seulement), et rien d'autre", async () => {
  const f = await connected();
  const relayed = [
    { type: "transcript", text: "salut", final: true }, { type: "reply.delta", text: "Sa" }, { type: "reply.done", text: "Salut" },
    { type: "notify", text: "Fini", important: true }, { type: "card", title: "T", lines: ["a"] }, { type: "error", text: "Boum" },
    { type: "approval.request", id: "a1", tool: "mail", summary: "Envoyer ?", level: "send", ttl_s: 30 }, { type: "approval.closed", id: "a1", ok: true },
    { type: "choice.request", id: "c1", title: "Quel ?", options, ttl_s: 30 }, { type: "choice.closed", id: "c1", picked: "a" },
  ];
  for (const m of relayed) f.input(m);
  expect(f.host.chat.mock.calls.map((c) => c[0])).toEqual(relayed);
  f.host.chat.mockClear();
  f.input({ type: "transcript", text: "sal", final: false });
  f.input({ type: "state", state: "thinking" });
  f.input({ type: "mood", valence: 0, energy: 0 });
  expect(f.host.chat).not.toHaveBeenCalled();
});

it("sans pont de conversation (anciens ponts, tests), la page marche quand même", async () => {
  vi.useFakeTimers();
  const f = await mountApp(hostStub());
  expect(() => { f.input({ type: "reply.delta", text: "a" }); f.input({ type: "reply.done", text: "a" }); }).not.toThrow();
  document.getElementById("openChat")!.click();
});

it("`choice.request` : une carte avec un bouton par option, la barre du temps, l'activité signalée à l'app", async () => {
  const f = await connected();
  f.input({ type: "choice.request", id: "c1", title: "Quel agenda ?", options, ttl_s: 20 });
  const card = f.cards.querySelector(".card.pick")!;
  expect(card.querySelector("h3")!.textContent).toBe("Quel agenda ?");
  const buttons = [...card.querySelectorAll("button")];
  expect(buttons.map((b) => b.firstChild!.textContent)).toEqual(["Perso", "Travail"]);
  expect(buttons[0]!.querySelector("small")!.textContent).toBe("Calendrier privé");
  expect(buttons[1]!.querySelector("small")).toBeNull();
  expect(card.querySelector(".ttl")).not.toBeNull();
  expect(f.host.activity).toHaveBeenCalledWith("approval");
  expect(f.bubble.classList.contains("hide")).toBe(false);
  buttons[1]!.click(); buttons[0]!.click();
  expect(sent(f.port)).toEqual([{ type: "choice.response", id: "c1", option: "b" }]);   // un seul envoi
  expect(buttons.every((b) => b.disabled)).toBe(true);
});

it("`choice.closed` retire la carte et rend la main à l'app ; une liste ouverte retient la bulle", async () => {
  const f = await connected();
  f.input({ type: "state", state: "idle" });
  f.input({ type: "choice.request", id: "c1", title: "Quel ?", options, ttl_s: 20 });
  f.input({ type: "choice.request", id: "c2", title: "Et ?", options, ttl_s: 20 });
  f.input({ type: "state", state: "idle" });
  vi.advanceTimersByTime(60000);
  expect(f.bubble.classList.contains("hide")).toBe(false);          // ni masquage ni fermeture tant qu'on n'a pas choisi
  expect(f.cards.querySelectorAll(".card.pick")).toHaveLength(2);
  f.input({ type: "choice.closed", id: "c1", picked: "a" });
  expect(f.cards.querySelectorAll(".card.pick")).toHaveLength(1);
  expect(f.host.approvalClosed).not.toHaveBeenCalled();            // il en reste un
  f.input({ type: "choice.closed", id: "c2" });
  expect(f.cards.querySelector(".card.pick")).toBeNull();
  expect(f.host.approvalClosed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(5000);
  expect(f.bubble.classList.contains("hide")).toBe(true);
});

it("une nouvelle connexion au noyau retire les listes et les accords restés ouverts, et prévient la conversation", async () => {
  const f = await connected();
  f.input({ type: "choice.request", id: "c1", title: "Quel ?", options, ttl_s: 20 });
  f.input({ type: "approval.request", id: "a1", tool: "mail", summary: "Envoyer ?", level: "send", ttl_s: 20 });
  f.host.chat.mockClear();
  f.app.protocol.connect(asPort(fakePort()));
  expect(f.cards.children).toHaveLength(0);
  expect(f.host.approvalClosed).toHaveBeenCalledOnce();
  expect(f.host.chat).toHaveBeenCalledWith({ type: "session.reset" });
});

it("ce qui est accordé ou choisi dans la conversation repart au noyau (message de la fenêtre)", async () => {
  const f = await connected();
  const message = (data: object) => f.app.protocol.windowMessage({ data, ports: [] } as unknown as MessageEvent);
  message({ floppyChatApproval: { id: "a1", ok: true } });
  message({ floppyChatApproval: { id: "a2", ok: false } });
  message({ floppyChatChoice: { id: "c1", option: "b" } });
  message({ floppyChatChoice: { id: 3, option: "b" } });
  expect(sent(f.port)).toEqual([
    { type: "approval.response", id: "a1", ok: true }, { type: "approval.response", id: "a2", ok: false },
    { type: "choice.response", id: "c1", option: "b" },
  ]);
});

it("« arrêter l'écoute » demandé dans la conversation fait comme le bouton de la bulle", async () => {
  const f = await connected();
  const message = (data: object) => f.app.protocol.windowMessage({ data, ports: [] } as unknown as MessageEvent);
  message({ floppyChatStopListening: "oui" });             // valeur inattendue : rien
  expect(sent(f.port)).toEqual([]);
  message({ floppyChatStopListening: true });
  expect(sent(f.port)).toEqual([{ type: "listen.stop" }]);
});

it("bouton de la bulle : ouvre la conversation, et son texte suit la langue de l'interface", async () => {
  vi.useFakeTimers();
  const host = chatHost();
  const f = await mountApp(host);
  const button = document.getElementById("openChat")!;
  expect(button.closest("#bubble")).not.toBeNull();             // accroché à la bulle : cliquable quand elle est visible
  expect(button.getAttribute("aria-label")).toBe("Ouvrir la conversation");
  button.click();
  expect(host.openChat).toHaveBeenCalledOnce();
  f.app.protocol.windowMessage({ data: { floppyDisplay: { lang: "en" } }, ports: [] } as unknown as MessageEvent);
  expect(button.getAttribute("aria-label")).toBe("Open the conversation");
  expect(button.getAttribute("title")).toBe("Open the conversation");
});

it("conversation ouverte et visible : la bulle disparaît ; elle revient quand la fenêtre se ferme ou se réduit", async () => {
  vi.useFakeTimers();
  const f = await mountApp(chatHost());
  const message = (on: boolean) => f.app.protocol.windowMessage({ data: { floppyChatOpen: on }, ports: [] } as unknown as MessageEvent);
  f.input({ type: "reply.delta", text: "bonjour" });
  expect(document.body.classList.contains("chatopen")).toBe(false);
  message(true);
  expect(document.body.classList.contains("chatopen")).toBe(true);
  message(false);
  expect(document.body.classList.contains("chatopen")).toBe(false);
  expect(f.bubble.classList.contains("hide")).toBe(false);       // la bulle reprend où elle en était
  expect(f.bubble.textContent).toContain("bonjour");
});

it("`show_card` : { title, lines } montrent la carte ; l'ancien nom d'outil n'existe plus", async () => {
  vi.useFakeTimers();
  const f = await mountApp(hostStub());
  const port = fakePort();
  f.app.protocol.connect(asPort(port));
  port.postMessage.mockClear();
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c9", name: "show_card", args: { title: "Comparatif", lines: ["un", "deux"] } } as never);
  expect(port.postMessage).toHaveBeenCalledWith({ j: expect.objectContaining({ type: "tool.result", callId: "c9", ok: true }) });
  expect(document.body.textContent).toContain("Comparatif");
  expect(document.body.textContent).toContain("deux");
  await f.app.protocol.onMessage({ type: "tool.call", callId: "c10", name: "afficher_carte", args: { titre: "X" } } as never);
  expect(port.postMessage).toHaveBeenCalledWith({ j: expect.objectContaining({ type: "tool.result", callId: "c10", ok: false }) });
});
