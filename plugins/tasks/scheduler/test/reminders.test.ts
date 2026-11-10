import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, tr } from "@floppy/core";
import { createSchedulerPlugin } from "../src/index.ts";
import { parseLocalDateTime, whenText } from "../src/reminders.ts";

const L = (m: number, d: number, h = 0, mi = 0) => new Date(2026, m - 1, d, h, mi, 0, 0);
const MIN = 60_000;

let k: Kernel | undefined;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); vi.setSystemTime(L(11, 6, 10, 0)); });
afterEach(async () => { await k?.stopAll(); k = undefined; vi.useRealTimers(); });

type Announce = { source: string; text: string; importance: string; key?: string };

async function start(home: string, language = "fr") {
  k = new Kernel({ logger: () => {}, home, plugins: [createSchedulerPlugin()] });
  const said: Announce[] = [];
  k.bus.on("initiative", (e) => { said.push(e as Announce); });
  await k.applyConfig({
    assistant: { language },
    approvals: { toolRules: ["set_reminder", "cancel_reminder"].map((tool) => ({ source: "scheduler", tool, level: "write", rule: "always" })) },
    plugins: [{ id: "scheduler", plugin: "scheduler", config: { reminderStartupDelay_s: 5 } }],
  } as never);
  return { k, said };
}
const home = () => mkdtempSync(join(tmpdir(), "rem-"));
const file = (h: string) => join(h, "scheduler", "reminders.json");
const stored = (h: string) => (JSON.parse(readFileSync(file(h), "utf8")) as { reminders: { id: string; text: string }[] }).reminders;

describe("lecture de l'heure", () => {
  it("lit AAAA-MM-JJTHH:MM en heure locale et refuse l'impossible", () => {
    expect(parseLocalDateTime("2026-11-07T09:30")).toBe(L(11, 7, 9, 30).getTime());
    expect(parseLocalDateTime("2026-02-31T09:30")).toBeUndefined();
    expect(parseLocalDateTime("demain 9h")).toBeUndefined();
  });
  it("dit l'heure en clair dans les deux langues", () => {
    expect(whenText(L(11, 6, 14, 30).getTime(), L(11, 6, 10).getTime())).toEqual({ fr: "aujourd'hui à 14:30", en: "today at 14:30" });
    expect(whenText(L(11, 7, 9, 0).getTime(), L(11, 6, 10).getTime())).toEqual({ fr: "demain à 09:00", en: "tomorrow at 09:00" });
    expect(whenText(L(12, 24, 9, 0).getTime(), L(11, 6, 10).getTime())).toEqual({ fr: "le 24/12 à 09:00", en: "on 24/12 at 09:00" });
  });
});

describe("rappels dans le noyau", () => {
  it("crée, liste et rend l'heure prévue", async () => {
    const h = home();
    const { k } = await start(h);
    const r = await k.tools.call("set_reminder", { text: "appeler Paul", in_minutes: 10 });
    expect(r.status).toBe("done");
    expect(r.text).toContain("appeler Paul");
    expect(r.text).toContain("aujourd'hui à 10:10");
    expect(stored(h)).toHaveLength(1);
    expect((await k.tools.call("list_reminders", {})).text).toContain("appeler Paul");
  });

  it("dit qu'il n'y a rien quand la liste est vide", async () => {
    const { k } = await start(home());
    expect((await k.tools.call("list_reminders", {})).text).toBe("Aucun rappel en attente.");
  });

  it("accepte une heure locale `at` et refuse le passé, le trop lointain, l'illisible, le double choix", async () => {
    const { k } = await start(home());
    expect((await k.tools.call("set_reminder", { text: "x", at: "2026-11-07T09:00" })).text).toContain("demain à 09:00");
    for (const args of [
      { text: "x", at: "2026-11-06T09:00" },
      { text: "x", in_minutes: -3 },
      { text: "x", in_minutes: 60 * 24 * 366 },
      { text: "x", at: "n'importe quoi" },
      { text: "x" },
      { text: "x", in_minutes: 5, at: "2026-11-07T09:00" },
      { text: "  ", in_minutes: 5 },
    ]) expect((await k.tools.call("set_reminder", args)).status).toBe("failed");
    expect(tr((await k.tools.call("list_reminders", {})).text, "fr").split("\n")).toHaveLength(1);
  });

  it("annule par id ou par mots, et refuse l'ambigu", async () => {
    const h = home();
    const { k } = await start(h);
    await k.tools.call("set_reminder", { text: "appeler Paul", in_minutes: 10 });
    await k.tools.call("set_reminder", { text: "appeler Pauline", in_minutes: 20 });
    await k.tools.call("set_reminder", { text: "sortir le pain", in_minutes: 30 });
    expect((await k.tools.call("cancel_reminder", { match: "appeler" })).status).toBe("failed"); // 2 correspondances
    expect(stored(h)).toHaveLength(3);
    expect((await k.tools.call("cancel_reminder", { match: "pain" })).status).toBe("done");
    expect((await k.tools.call("cancel_reminder", { match: "r1" })).text).toContain("appeler Paul");
    expect(stored(h).map((r) => r.id)).toEqual(["r2"]);
    expect((await k.tools.call("cancel_reminder", { match: "zzz" })).status).toBe("failed");
  });

  it("annonce à l'heure dite (important, clé unique, langue de l'assistant) puis retire le rappel", async () => {
    const h = home();
    const { k, said } = await start(h, "en");
    await k.tools.call("set_reminder", { text: "call Paul", in_minutes: 10 });
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(said).toEqual([{ source: "scheduler", text: "Reminder: call Paul", importance: "important", key: "reminder:r1" }]);
    expect(stored(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(said).toHaveLength(1);
  });

  it("réarme sur le plus proche quand un rappel plus tôt arrive, et après une annulation", async () => {
    const { k, said } = await start(home());
    await k.tools.call("set_reminder", { text: "tard", in_minutes: 60 });
    await k.tools.call("set_reminder", { text: "tôt", in_minutes: 5 });
    await k.tools.call("set_reminder", { text: "milieu", in_minutes: 30 });
    await k.tools.call("cancel_reminder", { match: "milieu" });
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(said.map((s) => s.text)).toEqual(["Rappel : tôt"]);
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(said.map((s) => s.text)).toEqual(["Rappel : tôt", "Rappel : tard"]);
  });

  it("arme par paliers un rappel lointain (plus de 24 jours)", async () => {
    const { k, said } = await start(home());
    await k.tools.call("set_reminder", { text: "dans longtemps", in_minutes: 60 * 24 * 40 });
    await vi.advanceTimersByTimeAsync(39 * 24 * 60 * MIN);
    expect(said).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * MIN);
    expect(said.map((s) => s.text)).toEqual(["Rappel : dans longtemps"]);
  });

  it("rattrape au démarrage un rappel passé pendant l'arrêt, en le disant en retard", async () => {
    const h = home();
    mkdirSync(join(h, "scheduler"), { recursive: true });
    writeFileSync(file(h), JSON.stringify({ reminders: [
      { id: "r1", text: "appeler Paul", due: L(11, 6, 8, 30).getTime(), created: L(11, 5, 9).getTime() },
      { id: "r2", text: "plus tard", due: L(11, 6, 12, 0).getTime(), created: L(11, 5, 9).getTime() },
    ] }));
    const { said } = await start(h);
    expect(said).toEqual([]); // pas avant le délai de démarrage
    await vi.advanceTimersByTimeAsync(6_000);
    expect(said.map((s) => s.text)).toEqual(["Rappel en retard, prévu à 08:30 : appeler Paul"]);
    expect(stored(h).map((r) => r.id)).toEqual(["r2"]);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(said).toHaveLength(2);
    expect(said[1]!.text).toBe("Rappel : plus tard"); // à l'heure : pas « en retard »
  });

  it("garde l'id suivant après un redémarrage et ignore une entrée abîmée", async () => {
    const h = home();
    mkdirSync(join(h, "scheduler"), { recursive: true });
    writeFileSync(file(h), JSON.stringify({ reminders: [{ id: "r7", text: "a", due: L(11, 7).getTime(), created: 0 }, { nope: true }] }));
    const { k } = await start(h);
    await k.tools.call("set_reminder", { text: "b", in_minutes: 5 });
    expect(stored(h).map((r) => r.id)).toEqual(["r7", "r8"]);
    expect(existsSync(file(h))).toBe(true);
  });

  it("demande l'accord sans règle ciblée (niveau write)", async () => {
    const h = home();
    k = new Kernel({ logger: () => {}, home: h, plugins: [createSchedulerPlugin()] });
    await k.applyConfig({ approvals: { write: "ask" }, plugins: [{ id: "scheduler", plugin: "scheduler" }] } as never);
    const requests: { summary: string }[] = [];
    k.bus.on("approval.request", (r) => { requests.push(r); });
    const p = k.tools.call("set_reminder", { text: "appeler Paul", in_minutes: 10 });
    await vi.advanceTimersByTimeAsync(30);
    expect(requests[0]!.summary).toContain("appeler Paul");
    expect(requests[0]!.summary).toContain("aujourd'hui à 10:10");
    k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
    expect((await p).status).toBe("done");
  });
});
