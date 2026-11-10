import { describe, it, expect } from "vitest";
import { jobsSection } from "../src/index.ts";

const NOW = new Date("2026-11-10T08:00:00Z");
const job = (id: string, state: "running" | "done" | "failed", finished?: string, result?: string) => ({ id, agent: "Claude", instruction: `mission ${id}`, state, started: "2026-11-09T10:00:00Z", ...(finished ? { finished } : {}), ...(result ? { result } : {}) });

describe("rubrique travaux des agents du point du matin", () => {
  it("liste les travaux finis depuis le dernier point et ceux en cours ; un échec est urgent", () => {
    const jobs = [job("a", "done", "2026-11-09T20:00:00Z", "tout est vert"), job("b", "failed", "2026-11-10T01:00:00Z"), job("c", "done", "2026-11-01T00:00:00Z"), job("d", "running")];
    const s = jobsSection(jobs, { lang: "fr", now: NOW, since: new Date("2026-11-09T08:00:00Z"), signal: AbortSignal.timeout(1000) });
    expect(s.urgent).toBe(true);
    expect(s.markdown).toBe("- Claude : mission a — fini. Résultat : tout est vert\n- Claude : mission b — échoué\n- Claude : mission d — en cours");
    expect(jobsSection([], { lang: "en", now: NOW, signal: AbortSignal.timeout(1000) })).toMatchObject({ empty: true, title: "Agent tasks" });
  });
});
