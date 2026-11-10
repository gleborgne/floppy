import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createInboxPlugin, MAX_APPS, settingKey } from "../src/index.ts";
import { checkActionUrl, cleanText, parseHello, parseMessage } from "../src/protocol.ts";

// Boîte aux lettres : une app locale dépose un message ; Floppy le dit ou l'affiche ; « ouvre-la » lance le lien.
let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

const APP = "inwink-differendum";
const KEY = settingKey(APP);
const hello = { kind: "hello", app: APP, name: "Differendum", schemes: ["inwink-differendum"] };
const msg = (extra: Record<string, unknown> = {}) => ({
  kind: "message", app: APP,
  text: { fr: "Vous avez été ajouté comme relecteur sur la PR 1234, Fix login.", en: "You were added as a reviewer on PR 1234, Fix login." },
  mode: "voice", key: "n-1",
  action: { label: { fr: "Ouvrir la PR 1234", en: "Open PR 1234" }, url: "inwink-differendum://pr?url=https%3A%2F%2Fdev.azure.com%2Fc%2Fp%2F_git%2Fr%2Fpullrequest%2F1234" },
  ...extra,
});

async function start(home = mkdtempSync(join(tmpdir(), "inbox-"))) {
  const opened: string[] = [];
  const k = new Kernel({ logger: () => {}, plugins: [createInboxPlugin({ opener: async (u) => { opened.push(u); } })], home });
  kernels.push(k);
  const got: { source: string; text: string; key?: string; importance: string }[] = [];
  k.bus.on("initiative", (e) => { got.push(e); });
  await k.applyConfig({ plugins: [{ id: "inbox", plugin: "inbox" }] });
  const file = join(home, "inbox.json");
  await vi.waitFor(() => expect(existsSync(file)).toBe(true));
  const info = JSON.parse(readFileSync(file, "utf8")) as { port: number; token: string };
  const post = async (body: unknown, token = info.token, path = "/inbox") => (await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).status;
  return { k, got, opened, post, home, file };
}

describe("boîte aux lettres", () => {
  it("de bout en bout : présentation, accord dans les réglages, annonce dite, puis « ouvre-la » après accord", async () => {
    const { k, got, opened, post } = await start();
    expect(await post(hello)).toBe(403);
    expect(await post(msg())).toBe(403);
    expect(got).toHaveLength(0);
    expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("denied");

    expect((await k.settings.change(KEY, "app", "ui")).ok).toBe(true);
    expect(await post(hello)).toBe(204);
    expect(await post(msg())).toBe(204);
    expect(got).toEqual([{ source: `inbox:${APP}`, text: "Vous avez été ajouté comme relecteur sur la PR 1234, Fix login.", importance: "important", key: `inbox:${APP}:n-1` }]);

    const list = await k.tools.call("list_recent_announcements", {});
    expect(k.tools.list().map((t) => t.name).filter((n) => ["annonces_recentes", "ouvrir_annonce"].includes(n))).toEqual([]); // les anciens noms français n'existent plus
    expect(JSON.stringify(list.text)).toContain("Ouvrir la PR 1234");

    let summary = "";
    k.bus.on("approval.request", (r) => { summary = JSON.stringify(r); k.approvals.respond(r.id, true, "test"); });
    expect((await k.tools.call("open_announcement", {})).status).toBe("done");
    expect(summary).toContain("Ouvrir la PR 1234 — inwink-differendum:// (Differendum)");
    expect(opened).toEqual([msg().action.url]);
  });

  it("carte de confirmation : un clic sur Oui autorise l'app ; elle n'est montrée qu'une fois", async () => {
    const { k, got, post } = await start();
    const asked: string[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r.summary); k.approvals.respond(r.id, true, "hub:fenetre"); });
    expect(await post(hello)).toBe(403);
    await vi.waitFor(() => expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("app"));
    expect(asked).toEqual(["J'ai reçu un message de l'application « Differendum ». Autoriser ses annonces ? Elle pourra faire ouvrir inwink-differendum:// et https."]);
    expect(got.at(-1)).toMatchObject({ text: "Differendum est autorisée.", importance: "normal" });
    expect(await post(hello)).toBe(204);
    expect(await post(msg())).toBe(204);
    expect(asked).toHaveLength(1);
  });

  it("carte de confirmation : un « oui » à la voix n'autorise pas ; un refus ne repose pas la question", async () => {
    const { k, got, post } = await start();
    let n = 0;
    k.bus.on("approval.request", (r) => { n++; k.approvals.respond(r.id, true, "conv:voix"); });
    await post(hello);
    await vi.waitFor(() => expect(got.some((g) => g.key === `inbox:clic:${APP}`)).toBe(true));
    expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("denied");
    expect(await post(hello)).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(1);
  });

  it("autoriser une app ne se fait jamais à la voix ; la couper, si", async () => {
    const { k, post } = await start();
    await post(hello);
    expect((await k.settings.change(KEY, "app", "voice")).ok).toBe(false);
    expect((await k.settings.change(KEY, "app", "ui")).ok).toBe(true);
    expect((await k.settings.change(KEY, "non", "voice")).ok).toBe(true);
    expect(await post(msg())).toBe(403);
  });

  it("mode info, ou « afficher seulement » : affiché, jamais dit", async () => {
    const { k, got, post } = await start();
    await post(hello);
    await k.settings.change(KEY, "app", "ui");
    expect(await post(msg({ mode: "info", key: "a" }))).toBe(204);
    expect(await post(msg({ mode: undefined, key: "b" }))).toBe(204);
    await k.settings.change(KEY, "info", "ui");
    expect(await post(msg({ key: "c" }))).toBe(204);
    expect(got.map((g) => g.importance)).toEqual(["normal", "normal", "normal"]);
  });

  it("jeton faux, mauvais chemin, message invalide, trop gros", async () => {
    const { k, post } = await start();
    expect(await post(hello, "faux")).toBe(401);
    expect(await post(hello, undefined, "/autre")).toBe(404);
    await post(hello);
    await k.settings.change(KEY, "app", "ui");
    expect(await post(msg({ action: { label: "Ouvrir", url: "file:///C:/Windows/system32/calc.exe" } }))).toBe(400);
    expect(await post(msg({ action: { label: "Ouvrir", url: "ms-settings:privacy" } }))).toBe(400);
    expect(await post(msg({ text: "" }))).toBe(400);
    expect(await post(msg({ mode: "fort" }))).toBe(400);
    expect(await post({ kind: "autre" })).toBe(400);
    expect(await post({ ...msg(), text: "x".repeat(70 * 1024) })).toBe(413);
  });

  it("une app qui change ses liens doit être autorisée de nouveau", async () => {
    const { k, post } = await start();
    await post(hello);
    await k.settings.change(KEY, "app", "ui");
    expect(await post({ ...hello, schemes: ["inwink-differendum", "autre-app"] })).toBe(403);
    await vi.waitFor(() => expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("denied"));
    expect(await post(msg())).toBe(403);
  });

  it("les apps connues et l'accord restent après un redémarrage ; le fichier de la porte est retiré à l'arrêt", async () => {
    const first = await start();
    await first.post(hello);
    await first.k.settings.change(KEY, "app", "ui");
    await first.k.stopAll();
    expect(existsSync(first.file)).toBe(false);
    kernels = [];
    const again = await start(first.home);
    expect(again.k.settings.list().find((s) => s.key === KEY)?.value).toBe("app");
    expect(await again.post(msg())).toBe(204);
  });

  it("un accord donné sur une vieille carte ne vaut pas pour des liens ajoutés depuis", async () => {
    const { k, post } = await start();
    const reqs: { id: string; summary: string }[] = [];
    k.bus.on("approval.request", (r) => { reqs.push(r); });
    await post({ ...hello, schemes: [] });
    await vi.waitFor(() => expect(reqs).toHaveLength(1));
    await post({ ...hello, schemes: ["rdp-app"] });
    k.approvals.respond(reqs[0]!.id, true, "hub:fenetre");
    await vi.waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]!.summary).toContain("rdp-app://");
    expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("denied");
    k.approvals.respond(reqs[1]!.id, true, "hub:fenetre");
    await vi.waitFor(() => expect(k.settings.list().find((s) => s.key === KEY)?.value).toBe("app"));
  });

  it("une seule carte à la fois ; un nouveau nom demande un nouvel accord", async () => {
    const { k, post } = await start();
    const reqs: { id: string; summary: string }[] = [];
    k.bus.on("approval.request", (r) => { reqs.push(r); });
    await post(hello);
    await post({ ...hello, app: "autre-app", name: "Autre", schemes: [] });
    await vi.waitFor(() => expect(reqs).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(reqs).toHaveLength(1);
    k.approvals.respond(reqs[0]!.id, true, "hub:fenetre");
    await vi.waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]!.summary).toContain("« Autre »");
    k.approvals.respond(reqs[1]!.id, false, "hub:fenetre");
    expect(await post(hello)).toBe(204);
    expect(await post({ ...hello, name: "Differendum 2" })).toBe(403);
    await vi.waitFor(() => expect(reqs).toHaveLength(3));
    expect(k.settings.list().find((s) => s.key === KEY)?.label).toEqual({ fr: "Application : Differendum 2", en: "App: Differendum 2" });
  });

  it("liste pleine : la plus ancienne app jamais autorisée est oubliée, jamais une app autorisée", async () => {
    let t = 0;
    const home = mkdtempSync(join(tmpdir(), "inbox-"));
    const k = new Kernel({ logger: () => {}, plugins: [createInboxPlugin({ opener: async () => {}, now: () => ++t * 1000 })], home });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "inbox", plugin: "inbox" }] });
    await vi.waitFor(() => expect(existsSync(join(home, "inbox.json"))).toBe(true));
    const info = JSON.parse(readFileSync(join(home, "inbox.json"), "utf8")) as { port: number; token: string };
    const post = async (body: unknown) => (await fetch(`http://127.0.0.1:${info.port}/inbox`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify(body) })).status;
    await post(hello);
    await k.settings.change(KEY, "app", "ui");
    for (let i = 1; i < MAX_APPS; i++) await post({ kind: "hello", app: `app-${i}`, name: `App ${i}`, schemes: [] });
    expect(await post({ kind: "hello", app: "nouvelle", name: "Nouvelle", schemes: [] })).toBe(403);
    const keys = k.settings.list().map((s) => s.key);
    expect(keys).toContain(settingKey("nouvelle"));
    expect(keys).not.toContain(settingKey("app-1"));
    expect(keys).toContain(KEY);
  });

  it("un fichier des apps abîmé : les entrées invalides sont écartées, la boîte s'ouvre", async () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-"));
    writeFileSync(join(home, "inbox-apps.json"), JSON.stringify({ apps: { [APP]: { name: "Differendum", schemes: ["inwink-differendum"], seen: "x", trust: "app" }, casse: { name: "Cassée", schemes: "pas une liste" }, "Pas Bon": { name: "x", schemes: [] } } }));
    const { k, post } = await start(home);
    expect(await post(msg())).toBe(204);
    expect(k.settings.list().filter((s) => s.key.startsWith("inbox_app_")).map((s) => s.key)).toEqual([KEY]);
  });

  it("rien à ouvrir : réponse claire, rien lancé", async () => {
    const { k, opened } = await start();
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, true, "test"); });
    expect((await k.tools.call("open_announcement", {})).status).toBe("failed");
    expect(opened).toHaveLength(0);
  });
});

describe("protocole", () => {
  it("présentation : id, nom et schémas vérifiés ; schémas dangereux refusés", () => {
    expect(parseHello(hello)).toEqual({ app: APP, name: "Differendum", schemes: ["inwink-differendum"] });
    expect(parseHello({ ...hello, app: "Pas Bon" })).toBeTypeOf("string");
    for (const s of ["file", "javascript", "ms-settings", "https", "search-ms"]) expect(parseHello({ ...hello, schemes: [s] })).toBeTypeOf("string");
    // Un nom est un nom : pas une phrase qui pousse à cliquer, pas de caractère de contrôle.
    for (const name of ["Floppy. Mise à jour prête ! Cliquez Oui", "Floppy[31m", "<b>x</b>"]) expect(parseHello({ ...hello, name })).toBeTypeOf("string");
    expect(parseHello({ ...hello, name: "Contoso Tracker (dev) 2.0" })).toMatchObject({ name: "Contoso Tracker (dev) 2.0" });
  });

  it("lien d'action : schéma déclaré ou https", () => {
    expect(checkActionUrl("https://dev.azure.com/x", [])).toBe("https://dev.azure.com/x");
    expect(checkActionUrl("inwink-differendum://pr?url=x", ["inwink-differendum"])).toBe("inwink-differendum://pr?url=x");
    expect(checkActionUrl("autre://x", ["inwink-differendum"])).toHaveProperty("error");
    expect(checkActionUrl("http://x", [])).toHaveProperty("error");
    // Rien qui puisse sortir des guillemets de la commande qui ouvre le lien.
    for (const u of ['contoso:x y"z', "contoso:\\x"]) expect(checkActionUrl(u, ["contoso"])).toHaveProperty("error");
    expect(checkActionUrl("https://x/a b", [])).toBe("https://x/a%20b");
    expect(checkActionUrl("contoso://xé", ["contoso"])).toBe("contoso://x%C3%A9");
  });

  it("textes : simple ou fr/en, nettoyés et bornés", () => {
    expect(cleanText("  bonjour\n  toi ", 50)).toBe("bonjour toi");
    expect(cleanText({ en: "hello" }, 50)).toEqual({ fr: "hello", en: "hello" });
    expect(cleanText("x".repeat(51), 50)).toBeUndefined();
    expect(parseMessage({ app: APP, text: "salut" }, [])).toEqual({ app: APP, text: "salut", mode: "info" });
  });

  it("mode : `voice` ; l'ancienne valeur `voix` des applications déjà écrites reste acceptée et devient `voice` ; le reste est refusé", () => {
    expect(parseMessage({ app: APP, text: "salut", mode: "voice" }, [])).toMatchObject({ mode: "voice" });
    expect(parseMessage({ app: APP, text: "salut", mode: "voix" }, [])).toMatchObject({ mode: "voice" });
    expect(parseMessage({ app: APP, text: "salut", mode: "info" }, [])).toMatchObject({ mode: "info" });
    expect(parseMessage({ app: APP, text: "salut", mode: "fort" }, [])).toBe("mode invalide");
  });
});
