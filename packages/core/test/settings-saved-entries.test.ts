// savedEntries : les valeurs gardées d'un préfixe (copie envoyée au processus d'un plugin tiers isolé).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../src/index.ts";

describe("réglages gardés par préfixe", () => {
  it("rend seulement les clés du préfixe ; un préfixe vide ne rend rien", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-saved-"));
    try {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ meteo_unite: "c", meteo_ville: "Lyon", voix: "x" }));
      const k = new Kernel({ home, logger: () => {}, plugins: [] });
      expect(k.settings.savedEntries("meteo_")).toEqual({ meteo_unite: "c", meteo_ville: "Lyon" });
      expect(k.settings.savedEntries("")).toEqual({});
      await k.stopAll();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
