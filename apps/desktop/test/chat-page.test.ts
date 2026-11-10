// @vitest-environment happy-dom
// Page de la fenêtre « Conversation » (les vrais fichiers chat.html et chat.ts, un pont simulé).
import { afterEach, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

type Cb<T> = (value: T) => void;
const listeners: [string, EventListener][] = [];

/** Monte chat.html, branche un faux pont (floppyChat) et charge chat.ts. */
async function mount(submit: () => Promise<boolean> = async () => true) {
  vi.resetModules();
  // Les écouteurs posés sur le document par une page précédente sont retirés (le document survit entre les tests).
  for (const [name, fn] of listeners) document.removeEventListener(name, fn);
  listeners.length = 0;
  const add = document.addEventListener.bind(document);
  document.addEventListener = ((name: string, fn: EventListener, ...rest: unknown[]) => { listeners.push([name, fn]); (add as Function)(name, fn, ...rest); }) as typeof document.addEventListener;
  const html = readFileSync("apps/desktop/src/renderer/chat.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  const cb: { init?: Cb<ChatInit>; change?: Cb<ChatDelta>; lang?: Cb<string>; focus?: () => void } = {};
  const host = {
    submit: vi.fn(submit), close: vi.fn(), answerApproval: vi.fn(), answerChoice: vi.fn(), link: vi.fn(),
    onInit: vi.fn((f: Cb<ChatInit>) => { cb.init = f; return () => {}; }),
    onChange: vi.fn((f: Cb<ChatDelta>) => { cb.change = f; return () => {}; }),
    onLang: vi.fn((f: Cb<string>) => { cb.lang = f; return () => {}; }),
    onFocus: vi.fn((f: () => void) => { cb.focus = f; return () => {}; }),
  };
  (window as unknown as { floppyChat: unknown }).floppyChat = host;
  await import("../src/renderer/chat.ts");
  const $ = (id: string) => document.getElementById(id)!;
  const prompt = $("prompt") as HTMLTextAreaElement;
  const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  return { host, cb, $, prompt, key, log: $("log"), error: $("error"), send: $("send") };
}

afterEach(() => { document.body.innerHTML = ""; });

const choice = (over: Partial<Extract<ChatEntry, { kind: "choice" }>> = {}): ChatEntry => ({
  id: 7, kind: "choice", key: "c1", title: "Quel agenda ?", ttl_s: 30, at: Date.now(), closed: false, picked: "",
  options: [{ id: "a", label: "Perso", detail: "Calendrier privé" }, { id: "b", label: "Travail" }, { id: "c", label: "Famille" }], ...over,
});

it("écrit : Entrée envoie une seule fois, vide le champ ; les blancs sont ignorés", async () => {
  let release!: (ok: boolean) => void;
  const f = await mount(() => new Promise<boolean>((r) => { release = r; }));
  f.prompt.value = "   ";
  f.key("Enter", {}, f.prompt);
  expect(f.host.submit).not.toHaveBeenCalled();
  f.prompt.value = "Bonjour";
  f.key("Enter", {}, f.prompt); f.key("Enter", {}, f.prompt);
  expect(f.host.submit).toHaveBeenCalledExactlyOnceWith("Bonjour");
  expect((f.send as HTMLButtonElement).disabled).toBe(true);
  release(true);
  await vi.waitFor(() => expect(f.prompt.value).toBe(""));
  expect(f.host.close).not.toHaveBeenCalled();           // la fenêtre reste ouverte
  expect((f.send as HTMLButtonElement).disabled).toBe(false);
});

it("Maj+Entrée et la composition (IME) restent dans le champ ; Échap ferme", async () => {
  const f = await mount();
  f.prompt.value = "ligne";
  f.key("Enter", { shiftKey: true }, f.prompt);
  f.key("Enter", { isComposing: true }, f.prompt);
  expect(f.host.submit).not.toHaveBeenCalled();
  f.key("Escape", { isComposing: true }); expect(f.host.close).not.toHaveBeenCalled();
  f.key("Escape"); expect(f.host.close).toHaveBeenCalledOnce();
  f.cb.focus!();
  expect(document.activeElement).toBe(f.prompt);
});

it("échec : le brouillon reste, l'erreur est traduite et suit la langue", async () => {
  const f = await mount(async () => false);
  f.prompt.value = "Ma demande";
  f.key("Enter", {}, f.prompt);
  await vi.waitFor(() => expect(f.error.hidden).toBe(false));
  expect(f.prompt.value).toBe("Ma demande");
  expect(f.error.textContent).toContain("pas encore prêt");
  expect((f.send as HTMLButtonElement).disabled).toBe(false);
  f.cb.lang!("en");
  expect(f.error.textContent).toContain("not ready");
  // Un envoi qui lève une exception est traité de la même façon.
  f.host.submit.mockRejectedValueOnce(new Error("boum"));
  f.key("Enter", {}, f.prompt);
  await vi.waitFor(() => expect(f.host.submit).toHaveBeenCalledTimes(2));
  expect(f.prompt.value).toBe("Ma demande");
});

it("la langue de l'interface change les textes de la page et des entrées, en direct", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [{ id: 1, kind: "you", text: "Salut" }, { id: 2, kind: "info", title: "", text: "Fini", important: true }] });
  expect(f.log.textContent).toContain("Toi");
  expect(f.log.textContent).toContain("Important");
  expect(f.send.textContent).toBe("Envoyer");
  expect(document.documentElement.lang).toBe("fr");
  f.cb.lang!("en");
  expect(document.documentElement.lang).toBe("en");
  expect(f.send.textContent).toBe("Send");
  expect(f.prompt.placeholder).toBe("Write to Floppy…");
  expect(f.log.textContent).toContain("You");
  expect(f.log.textContent).toContain("Salut");
  expect(f.$("hint").textContent).toContain("Shift+Enter");
});

it("le journal entier au chargement, puis des changements : texte brut en cours, HTML nettoyé une fois terminée", async () => {
  const f = await mount();
  expect(f.$("empty").hidden).toBe(false);
  f.cb.init!({ lang: "fr", entries: [{ id: 1, kind: "you", text: "<img src=x onerror=alert(1)>" }] });
  expect(f.$("empty").hidden).toBe(true);
  expect(f.log.querySelector("img")).toBeNull();                      // « toi » reste du texte
  expect(f.log.textContent).toContain("<img src=x");
  f.cb.change!({ changed: [{ id: 2, kind: "reply", text: "Voici <b>du gras</b>", html: "", done: false }], removed: [] });
  expect(f.log.querySelector(".stream b")).toBeNull();                 // pas encore rendue : texte brut
  expect(f.log.querySelector(".stream")!.textContent).toBe("Voici <b>du gras</b>");
  f.cb.change!({ changed: [{ id: 2, kind: "reply", text: "Voici **du gras**", html: "<p>Voici <strong>du gras</strong></p>", done: true }], removed: [] });
  expect(f.log.querySelector(".md strong")!.textContent).toBe("du gras");
  expect(f.log.querySelectorAll(".msg.reply")).toHaveLength(1);
  f.cb.change!({ changed: [], removed: [1] });
  expect(f.log.querySelector(".msg.you")).toBeNull();
});

it("infos et erreurs : cartes compactes", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [{ id: 1, kind: "info", title: "Météo", text: "Beau", important: false }, { id: 2, kind: "error", text: "Boum" }] });
  expect(f.log.querySelector(".card.info h3")!.textContent).toBe("Météo");
  expect(f.log.querySelector(".card.error")!.textContent).toContain("Erreur");
  expect(f.log.querySelector(".card.error")!.textContent).toContain("Boum");
});

it("les liens d'une réponse ouvrent le navigateur par l'app, jamais dans la fenêtre", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [{ id: 1, kind: "reply", text: "x", html: "<p><a href=\"https://example.com/a\">lien</a></p>", done: true }] });
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  f.log.querySelector("a")!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(f.host.link).toHaveBeenCalledWith("https://example.com/a");
});

it("accord : Oui / Non vont à l'app une seule fois ; fermé, l'entrée montre le résultat et perd ses boutons", async () => {
  const f = await mount();
  const approval = (outcome: "pending" | "yes" | "no"): ChatEntry => ({ id: 3, kind: "approval", key: "a1", summary: "Envoyer le mail ?", ttl_s: 30, at: Date.now(), outcome });
  f.cb.init!({ lang: "fr", entries: [approval("pending")] });
  const buttons = [...f.log.querySelectorAll<HTMLButtonElement>(".card.ask button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Oui", "Non"]);
  buttons[0]!.click(); buttons[1]!.click();
  expect(f.host.answerApproval).toHaveBeenCalledExactlyOnceWith("a1", true);
  expect(buttons.every((b) => b.disabled)).toBe(true);
  f.cb.change!({ changed: [approval("yes")], removed: [] });
  expect(f.log.querySelectorAll(".card.ask button")).toHaveLength(0);
  expect(f.log.querySelector(".card.ask .outcome")!.textContent).toBe("Accordé");
  f.cb.change!({ changed: [{ ...approval("no"), id: 4, key: "a2" }], removed: [] });
  expect(f.log.querySelectorAll(".card.ask .outcome")).toHaveLength(2);
  f.cb.lang!("en");
  expect([...f.log.querySelectorAll(".card.ask .outcome")].map((o) => o.textContent)).toEqual(["Approved", "Refused or expired"]);
});

it("choix : une ligne cliquable par option (libellé, détail), un clic envoie l'option choisie", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [choice()] });
  const rows = [...f.log.querySelectorAll<HTMLButtonElement>(".card.pick .opt")];
  expect(f.log.querySelector(".card.pick h3")!.textContent).toBe("Quel agenda ?");
  expect(rows).toHaveLength(3);
  expect(rows[0]!.textContent).toContain("Perso");
  expect(rows[0]!.textContent).toContain("Calendrier privé");
  expect(rows.map((r) => r.querySelector(".n")!.textContent)).toEqual(["1", "2", "3"]);
  expect(f.log.querySelector(".card.pick .ttl")).not.toBeNull();
  rows[1]!.click(); rows[2]!.click();
  expect(f.host.answerChoice).toHaveBeenCalledExactlyOnceWith("c1", "b");
});

it("choix : les touches 1 à 9 visent la ligne, sauf quand on écrit dans le champ", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [choice()] });
  // Dans le champ avec du texte : le chiffre est du texte.
  f.prompt.focus(); f.prompt.value = "3 oeufs";
  const typed = f.key("2", {}, f.prompt);
  expect(typed.defaultPrevented).toBe(false);
  expect(f.host.answerChoice).not.toHaveBeenCalled();
  // Modificateurs, ou numéro sans ligne : rien.
  f.prompt.value = "";
  f.key("2", { ctrlKey: true }, f.prompt); f.key("2", { isComposing: true }, f.prompt); f.key("9", {}, f.prompt);
  expect(f.host.answerChoice).not.toHaveBeenCalled();
  // Champ vide (même actif) ou focus ailleurs : le chiffre choisit.
  const picked = f.key("2", {}, f.prompt);
  expect(picked.defaultPrevented).toBe(true);
  expect(f.host.answerChoice).toHaveBeenCalledExactlyOnceWith("c1", "b");
  f.key("3");                                           // déjà répondu : un seul envoi
  expect(f.host.answerChoice).toHaveBeenCalledOnce();
  // Un autre choix, focus hors du champ.
  f.prompt.value = "texte"; (document.activeElement as HTMLElement).blur();
  f.cb.change!({ changed: [choice({ id: 8, key: "c2" })], removed: [] });
  f.key("1");
  expect(f.host.answerChoice).toHaveBeenLastCalledWith("c2", "a");
});

it("choix fermé : l'entrée montre l'option retenue (ou « aucun choix ») et n'est plus cliquable", async () => {
  const f = await mount();
  f.cb.init!({ lang: "fr", entries: [choice()] });
  f.cb.change!({ changed: [choice({ closed: true, picked: "c" })], removed: [] });
  expect(f.log.querySelectorAll(".card.pick button")).toHaveLength(0);
  expect(f.log.querySelector(".card.pick .outcome")!.textContent).toBe("Choix : Famille");
  f.key("1");                                          // plus de choix en attente
  expect(f.host.answerChoice).not.toHaveBeenCalled();
  f.cb.change!({ changed: [choice({ id: 9, key: "c9", closed: true, picked: "" })], removed: [] });
  expect([...f.log.querySelectorAll(".outcome")].at(-1)!.textContent).toBe("Aucun choix");
  f.cb.lang!("en");
  expect([...f.log.querySelectorAll(".outcome")].map((o) => o.textContent)).toEqual(["Chosen: Famille", "No choice"]);
});

it("le fil suit le bas, sauf si l'utilisateur est remonté", async () => {
  const f = await mount();
  let top = 0;
  Object.defineProperty(f.log, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(f.log, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(f.log, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  const add = (id: number) => f.cb.change!({ changed: [{ id, kind: "you", text: `m${id}` }], removed: [] });
  add(1);
  expect(top).toBe(1000);
  top = 300; f.log.dispatchEvent(new Event("scroll"));   // remonté à la main
  add(2);
  expect(top).toBe(300);
  top = 900; f.log.dispatchEvent(new Event("scroll"));   // revenu en bas : il suit à nouveau
  add(3);
  expect(top).toBe(1000);
});
