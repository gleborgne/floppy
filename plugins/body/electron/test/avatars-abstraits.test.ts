// Les avatars WebGL récents (essaim, gyre, goutte, oscillo, iris, pixelcat) sont des plugins d'avatar comme les autres : avatar.json + renderer/index.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import avatarEssaim from "@floppy/plugin-avatar-essaim";
import avatarGyre from "@floppy/plugin-avatar-gyre";
import avatarGoutte from "@floppy/plugin-avatar-goutte";
import avatarOscillo from "@floppy/plugin-avatar-oscillo";
import avatarIris from "@floppy/plugin-avatar-iris";
import avatarPixelcat from "@floppy/plugin-avatar-pixelcat";
import { readAvatarDir } from "../src/index.ts";

describe("avatars WebGL récents", () => {
  for (const [id, plugin] of [["essaim", avatarEssaim], ["gyre", avatarGyre], ["goutte", avatarGoutte], ["oscillo", avatarOscillo], ["iris", avatarIris], ["pixelcat", avatarPixelcat]] as const) {
    it(`${id} : plugin, avatar.json et dessin avec l'interface complète`, () => {
      expect(plugin.manifest.id).toBe(`avatar-${id}`);
      const root = fileURLToPath(new URL(`../../../avatar/${id}/`, import.meta.url));
      const a = readAvatarDir(root);
      expect(a.id).toBe(id);
      expect(a.emotions.length).toBeGreaterThan(5);
      const src = readFileSync(new URL(a.url), "utf8");
      for (const fn of ["setState", "setEmotion", "setLevel", "setMood", "lookAt", "setHearing", "cue", "destroy"]) expect(src).toContain(`${fn}(`);
      expect(src).toContain("webgl2");
    });
  }
});
