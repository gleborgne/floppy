import { describe, it, expect } from "vitest";
import { STATES } from "@floppy/protocol";
import { TRANSITIONS, canListenWithoutWake, isExpectedTransition, openListeningState, type BodyFlags } from "../src/body-state.ts";

const flags = (f: Partial<BodyFlags> = {}): BodyFlags => ({ muted: false, turn: false, init: false, playing: false, awakeUntil: 0, ...f });
const NOW = 1_000_000;

describe("état montré d'après les drapeaux", () => {
  it("écouter sans mot d'activation : écoute libre ou bouton parler, jamais en veille", () => {
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW + 1 }, NOW)).toBe(true);
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW }, NOW)).toBe(true);
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW - 1 }, NOW)).toBe(false);
    expect(canListenWithoutWake({ muted: true, awakeUntil: NOW + 1000 }, NOW)).toBe(false);
    expect(canListenWithoutWake({ muted: false, ptt: true, awakeUntil: 0 }, NOW)).toBe(true);
  });
  it("l'écoute libre d'un corps muet reste « sleep »", () => {
    expect(openListeningState({ muted: true })).toBe("sleep");
    expect(openListeningState({ muted: false })).toBe("listening");
  });
});

describe("table des transitions", () => {
  it("couvre chaque état et ne cite que des états connus", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) for (const to of targets) expect(STATES).toContain(to);
  });
  it.each([
    ["sleep", "idle"], ["sleep", "listening"], ["idle", "listening"], ["listening", "thinking"], ["thinking", "speaking"],
    ["speaking", "listening"], ["thinking", "listening"], ["thinking", "idle"], ["speaking", "thinking"], ["idle", "speaking"],
  ] as const)("%s → %s est prévu", (from, to) => { expect(isExpectedTransition(from, to)).toBe(true); });
  it("rester sur place et passer en veille sont toujours permis", () => {
    for (const s of STATES) { expect(isExpectedTransition(s, s)).toBe(true); expect(isExpectedTransition(s, "sleep")).toBe(true); }
  });
  it("une transition absente de la table est signalée", () => {
    expect(isExpectedTransition("sleep", "speaking")).toBe(false);
  });
});
