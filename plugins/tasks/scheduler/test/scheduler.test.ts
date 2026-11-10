import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, definePlugin, type PluginDef, type TaskService } from "@floppy/core";
import { createSchedulerPlugin, parseSchedule, formatSchedule, scheduleText, lastOccurrence, nextOccurrence, isDue } from "../src/index.ts";

// Dates locales fixes. Le 6 novembre 2026 est un vendredi.
const L = (m: number, d: number, h = 0, mi = 0) => new Date(2026, m - 1, d, h, mi, 0, 0);

describe("lecture et écriture d'une planification", () => {
  it("lit les heures, les jours, les périodes et « jamais »", () => {
    const ok = (s: string) => { const p = parseSchedule(s); return p.ok ? p.schedule : "ERREUR"; };
    expect(ok("07:30")).toEqual({ at: "07:30" });
    expect(ok("à 8h")).toEqual({ at: "08:00" });
    expect(ok("à 8 h")).toEqual({ at: "08:00" });
    expect(ok("8h")).toEqual({ at: "08:00" }); // à la voix, « à 8 h » arrive souvent sans le « à » : une heure
    expect(ok("7h30")).toEqual({ at: "07:30" });
    expect(ok("07:30 lun-ven")).toEqual({ at: "07:30", days: [1, 2, 3, 4, 5] });
    expect(ok("à 8h du lundi au vendredi")).toEqual({ at: "08:00", days: [1, 2, 3, 4, 5] });
    expect(ok("09:00 lundi, jeudi")).toEqual({ at: "09:00", days: [1, 4] });
    expect(ok("09:00 week-end")).toEqual({ at: "09:00", days: [6, 7] });
    expect(ok("09:00 tous les jours")).toEqual({ at: "09:00" });
    expect(ok("toutes les 3h")).toEqual({ every: "3h" });
    expect(ok("toutes les 3 heures")).toEqual({ every: "3h" });
    expect(ok("30 min")).toEqual({ every: "30m" });
    expect(ok("toutes les 30 minutes")).toEqual({ every: "30m" });
    expect(ok("jamais")).toBeNull();
    expect(ok("OFF")).toBeNull();
  });

  it("comprend aussi l'anglais (la valeur gardée reste en français)", () => {
    const ok = (s: string) => { const p = parseSchedule(s); return p.ok ? p.schedule : "ERREUR"; };
    expect(ok("at 8am")).toEqual({ at: "08:00" });
    expect(ok("7:30 pm")).toEqual({ at: "19:30" });
    expect(ok("12am")).toEqual({ at: "00:00" });
    expect(ok("7:30 mon-fri")).toEqual({ at: "07:30", days: [1, 2, 3, 4, 5] });
    expect(ok("8am monday to friday")).toEqual({ at: "08:00", days: [1, 2, 3, 4, 5] });
    expect(ok("09:00 monday and thursday")).toEqual({ at: "09:00", days: [1, 4] });
    expect(ok("09:00 weekends")).toEqual({ at: "09:00", days: [6, 7] });
    expect(ok("09:00 weekdays")).toEqual({ at: "09:00", days: [1, 2, 3, 4, 5] });
    expect(ok("09:00 every day")).toEqual({ at: "09:00" });
    expect(ok("every 3 hours")).toEqual({ every: "3h" });
    expect(ok("every 30 minutes")).toEqual({ every: "30m" });
    expect(ok("never")).toBeNull();
    for (const bad of ["tomorrow", "13pm", "8am blabla"]) expect(parseSchedule(bad).ok).toBe(false);
    const p = parseSchedule("tomorrow");
    expect(!p.ok && p.error).toMatchObject({ en: expect.stringMatching(/^I don't understand "tomorrow"/) });
    expect(scheduleText({ at: "07:30", days: [1, 2, 3, 4, 5] })).toEqual({ fr: "07:30 lun-ven", en: "07:30 Mon-Fri" });
    expect(scheduleText({ every: "30m" })).toEqual({ fr: "toutes les 30 min", en: "every 30 min" });
    expect(scheduleText(null)).toEqual({ fr: "jamais", en: "never" });
  });

  it("refuse ce qu'il ne comprend pas", () => {
    for (const bad of ["demain", "25:00", "8h99", "8h blabla", "2m"]) expect(parseSchedule(bad).ok).toBe(false);
  });

  it("écrit comme on le dit, et relit ce qu'il écrit", () => {
    expect(formatSchedule({ at: "07:30" })).toBe("07:30");
    expect(formatSchedule({ at: "07:30", days: [1, 2, 3, 4, 5] })).toBe("07:30 mon-fri");
    expect(formatSchedule({ at: "07:30", days: [1, 4] })).toBe("07:30 mon,thu");
    expect(formatSchedule({ every: "3h" })).toBe("every 3h");
    expect(formatSchedule({ every: "30m" })).toBe("every 30 min");
    expect(formatSchedule(null)).toBe("never");
    for (const s of ["07:30 mon-fri", "09:00 mon,thu,sat,sun", "every 3h", "every 30 min", "never"]) {
      const p = parseSchedule(s);
      expect(p.ok && formatSchedule(p.schedule)).toBe(s);
    }
  });
});

describe("dernière et prochaine heure prévue", () => {
  it("prend aujourd'hui si l'heure est passée, sinon hier", () => {
    expect(lastOccurrence({ at: "07:30" }, L(11, 6, 10, 0))).toEqual(L(11, 6, 7, 30));
    expect(lastOccurrence({ at: "07:30" }, L(11, 6, 7, 30))).toEqual(L(11, 6, 7, 30));
    expect(lastOccurrence({ at: "07:30" }, L(11, 6, 6, 0))).toEqual(L(11, 5, 7, 30));
  });

  it("respecte les jours (lundi à vendredi : le samedi renvoie vendredi)", () => {
    const sem = { at: "07:30", days: [1, 2, 3, 4, 5] };
    expect(lastOccurrence(sem, L(11, 7, 12, 0))).toEqual(L(11, 6, 7, 30)); // samedi
    expect(lastOccurrence(sem, L(11, 8, 12, 0))).toEqual(L(11, 6, 7, 30)); // dimanche
    expect(lastOccurrence(sem, L(11, 9, 6, 0))).toEqual(L(11, 6, 7, 30)); // lundi avant l'heure
    expect(nextOccurrence(sem, L(11, 6, 8, 0))).toEqual(L(11, 9, 7, 30)); // vendredi après l'heure : lundi
  });

  it("pas d'heure pour une période, ni pour une liste de jours vide", () => {
    expect(lastOccurrence({ every: "3h" }, L(11, 6))).toBeUndefined();
    expect(lastOccurrence({ at: "07:30", days: [] }, L(11, 6))).toBeUndefined();
  });
});

describe("isDue", () => {
  const at = { at: "07:30" };
  it("jamais passée : due", () => {
    expect(isDue(at, undefined, L(11, 6, 6, 0))).toBe(true);
    expect(isDue({ every: "3h" }, undefined, L(11, 6, 6, 0))).toBe(true);
  });
  it("heure : due seulement quand l'heure prévue est passée depuis la dernière réussite", () => {
    const hier = L(11, 5, 7, 31).toISOString();
    expect(isDue(at, hier, L(11, 6, 7, 29))).toBe(false);
    expect(isDue(at, hier, L(11, 6, 7, 30))).toBe(true);
    expect(isDue(at, L(11, 6, 7, 32), L(11, 6, 18, 0))).toBe(false); // déjà faite aujourd'hui
  });
  it("passage manqué : rattrapé (PC éteint deux jours)", () => {
    expect(isDue(at, L(11, 4, 7, 31), L(11, 6, 10, 0))).toBe(true);
  });
  it("jours : pas de passage prévu le week-end, rien à rattraper", () => {
    const sem = { at: "07:30", days: [1, 2, 3, 4, 5] };
    expect(isDue(sem, L(11, 6, 7, 31), L(11, 8, 12, 0))).toBe(false); // dimanche : vendredi a eu lieu
    expect(isDue(sem, L(11, 5, 7, 31), L(11, 8, 12, 0))).toBe(true); // vendredi manqué
  });
  it("période : due quand elle est écoulée", () => {
    const e = { every: "3h" };
    expect(isDue(e, L(11, 6, 7, 0), L(11, 6, 9, 59))).toBe(false);
    expect(isDue(e, L(11, 6, 7, 0), L(11, 6, 10, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Avec le noyau
// ---------------------------------------------------------------------------------------------------------------

const quiet = () => {};
let k: Kernel | undefined;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(async () => { await k?.stopAll(); k = undefined; vi.useRealTimers(); });

/** Plugin avec une tâche à 07:30 ; note chaque passage. */
function digest(runs: Date[], opts: { fail?: boolean } = {}): PluginDef<any> {
  return definePlugin({
    manifest: {
      id: "digest", version: "0", licence: "MIT", provides: ["task"],
      tasks: [{ id: "quotidienne", label: "Veille du jour", schedule: { at: "07:30" } }],
    },
    apply(ctx) {
      const svc: TaskService = {
        async run() {
          runs.push(new Date());
          if (opts.fail) throw new Error("source en panne");
          return { summary: "Ta veille est prête." };
        },
      };
      ctx.provide("task", svc);
    },
  });
}

/** Dossier de données avec une dernière réussite connue. */
function homeWith(lastRun?: Date): string {
  const home = mkdtempSync(join(tmpdir(), "sched-"));
  if (lastRun) writeFileSync(join(home, "tasks.json"), JSON.stringify({ "veille/quotidienne": { lastRun: lastRun.toISOString() } }));
  return home;
}

async function start(runs: Date[], home: string, opts: { fail?: boolean; delaiDemarrageS?: number } = {}) {
  k = new Kernel({ logger: quiet, home, plugins: [digest(runs, opts), createSchedulerPlugin()] });
  await k.applyConfig({ plugins: [
    { id: "veille", plugin: "digest" },
    { id: "scheduler", plugin: "scheduler", config: { delaiDemarrageS: opts.delaiDemarrageS ?? 120 } },
  ] });
  return k;
}

const avance = (min: number) => vi.advanceTimersByTimeAsync(min * 60_000);

describe("planificateur dans le noyau", () => {
  it("lance la tâche à l'heure prévue, une seule fois", async () => {
    vi.setSystemTime(L(11, 6, 6, 0));
    const runs: Date[] = [];
    await start(runs, homeWith(L(11, 5, 7, 31)));
    await avance(60); // 07:00
    expect(runs).toEqual([]);
    await avance(31); // 07:31
    expect(runs).toHaveLength(1);
    expect(runs[0]!.getHours()).toBe(7);
    expect(runs[0]!.getMinutes()).toBe(30); // le tick de 07:30 pile
    await avance(180); // 3 h plus tard : pas de 2e passage
    expect(runs).toHaveLength(1);
  });

  it("rattrape un passage manqué une fois, après le délai de démarrage", async () => {
    vi.setSystemTime(L(11, 6, 10, 0)); // PC allumé à 10 h, dernière veille avant-hier
    const runs: Date[] = [];
    await start(runs, homeWith(L(11, 4, 7, 31)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual([]); // les modèles se chargent
    await vi.advanceTimersByTimeAsync(90_000);
    expect(runs).toHaveLength(1);
    await avance(30);
    expect(runs).toHaveLength(1);
  });

  it("pas de rattrapage si la tâche a déjà tourné depuis l'heure prévue", async () => {
    vi.setSystemTime(L(11, 6, 10, 0));
    const runs: Date[] = [];
    await start(runs, homeWith(L(11, 6, 7, 32)));
    await avance(10);
    expect(runs).toEqual([]);
  });

  it("un échec n'est pas relancé chaque minute", async () => {
    vi.setSystemTime(L(11, 6, 10, 0));
    const runs: Date[] = [];
    await start(runs, homeWith(L(11, 4, 7, 31)), { fail: true, delaiDemarrageS: 0 });
    await avance(20);
    expect(runs).toHaveLength(1);
    await avance(20); // 30 min passées : nouvel essai
    expect(runs).toHaveLength(2);
  });

  it("réglage à la voix : « jamais » arrête, une autre heure remplace celle du manifeste", async () => {
    vi.setSystemTime(L(11, 6, 6, 0));
    const runs: Date[] = [];
    const kk = await start(runs, homeWith(L(11, 5, 7, 31)));
    const key = "tasks.veille.quotidienne";
    expect(kk.settings.list().find((s) => s.key === key)).toMatchObject({ value: "07:30", type: "text", risk: "free", section: "tasks" });

    expect((await kk.settings.change(key, "jamais", "voice")).ok).toBe(true);
    await avance(120); // 08:00 : 07:30 est passée mais la tâche est coupée
    expect(runs).toEqual([]);

    expect((await kk.settings.change(key, "09:00", "voice")).ok).toBe(true);
    await avance(30); // 08:30
    expect(runs).toEqual([]);
    await avance(40); // 09:10
    expect(runs).toHaveLength(1);

    const bad = await kk.settings.change(key, "n'importe quoi", "voice");
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/comprends pas/);
  });

  it("garde le choix de l'utilisateur d'un démarrage à l'autre", async () => {
    vi.setSystemTime(L(11, 6, 6, 0));
    const home = homeWith(L(11, 5, 7, 31));
    const kk = await start([], home);
    await kk.settings.change("tasks.veille.quotidienne", "à 8h30 lun-ven", "voice");
    await kk.stopAll();
    const kk2 = await start([], home);
    expect(kk2.settings.list().find((s) => s.key === "tasks.veille.quotidienne")!.value).toBe("08:30 mon-fri");
  });

  it("déclare la rubrique « Tâches »", async () => {
    vi.setSystemTime(L(11, 6, 6, 0));
    const kk = await start([], homeWith());
    expect(kk.sections.list().find((s) => s.id === "tasks")?.label).toEqual({ fr: "Tâches", en: "Tasks" });
  });
});
