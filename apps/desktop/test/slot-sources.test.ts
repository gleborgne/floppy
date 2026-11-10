import { describe, it, expect } from "vitest";
import { slotSources } from "../src/renderer/slot-sources.ts";

// Rubrique Voix : audio.cpp déclare ses éléments, la voix du système n'offre que par ctx.offer.
const audiocpp = { id: "local-voice", source: "tts-audiocpp", offers: "tts", items: [{ id: "anna" }] };
const apps = {
  id: "apps-voice", source: "core",
  kinds: [{ id: "tts-audiocpp", provides: ["tts"] }, { id: "tts-system", provides: ["tts"] }, { id: "notes", provides: ["notes"] }],
  items: [{ id: "tts-audiocpp", kind: "tts-audiocpp" }, { id: "tts-system", kind: "tts-system" }, { id: "notes", kind: "notes" }],
};
const options = [{ value: "@none" }, { value: "tts-audiocpp/anna" }, { value: "tts-system/julie" }, { value: "tts-system/zira" }];

describe("slotSources", () => {
  it("montre un plugin installé qui n'offre ses choix que par ctx.offer", () => {
    const out = slotSources([audiocpp, apps], options, "tts");
    expect(out.map((x: { source: string }) => x.source)).toEqual(["tts-audiocpp", "tts-system"]);
    expect(out[0].provs).toEqual([audiocpp]);
    expect(out[0].options).toEqual([]);
    expect(out[1].options.map((o: { value: string }) => o.value)).toEqual(["tts-system/julie", "tts-system/zira"]);
  });

  it("garde un plugin installé éteint (il n'offre plus rien)", () => {
    const out = slotSources([apps], [{ value: "@none" }], "tts");
    expect(out.map((x: { source: string }) => x.source)).toEqual(["tts-audiocpp", "tts-system"]);
  });

  it("ignore les plugins installés d'un autre service", () => {
    const out = slotSources([apps], [], "notes");
    expect(out.map((x: { source: string }) => x.source)).toEqual(["notes"]);
  });
});
