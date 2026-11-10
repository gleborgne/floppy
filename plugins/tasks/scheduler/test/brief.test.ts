import { describe, it, expect } from "vitest";
import { remindersSection } from "../src/reminders.ts";

const NOW = new Date(2026, 10, 10, 8, 0);
const at = (h: number, m = 0, day = 10) => new Date(2026, 10, day, h, m).getTime();

describe("rubrique rappels du point du matin", () => {
  it("garde les rappels d'ici minuit (et ceux en retard), urgent si l'un tombe dans l'heure", () => {
    const list = [{ id: "r1", text: "appeler Paul", due: at(8, 30), created: 0 }, { id: "r2", text: "demain", due: at(9, 0, 11), created: 0 }, { id: "r3", text: "oublié", due: at(7, 0), created: 0 }];
    const s = remindersSection(list, { lang: "fr", now: NOW, signal: AbortSignal.timeout(1000) });
    expect(s).toEqual({ title: "Rappels du jour", urgent: true, markdown: "- 07:00 : oublié (en retard)\n- 08:30 : appeler Paul" });
    expect(remindersSection([], { lang: "en", now: NOW, signal: AbortSignal.timeout(1000) })).toEqual({ title: "Reminders today", markdown: "No reminder today.", empty: true });
  });
});
