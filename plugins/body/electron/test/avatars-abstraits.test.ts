// Les avatars WebGL récents (swarm, gyre, droplet, neon-scope, iris, pixelcat) sont des plugins d'avatar comme les autres : avatar.json + renderer/index.js.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import avatarSwarm from "@floppy/plugin-avatar-swarm";
import avatarGyre from "@floppy/plugin-avatar-gyre";
import avatarDroplet from "@floppy/plugin-avatar-droplet";
import avatarNeonScope from "@floppy/plugin-avatar-neon-scope";
import avatarIris from "@floppy/plugin-avatar-iris";
import avatarPixelcat from "@floppy/plugin-avatar-pixelcat";
import { readAvatarDir } from "../src/index.ts";

describe("avatars WebGL récents", () => {
  for (const [id, plugin] of [["swarm", avatarSwarm], ["gyre", avatarGyre], ["droplet", avatarDroplet], ["neon-scope", avatarNeonScope], ["iris", avatarIris], ["pixelcat", avatarPixelcat]] as const) {
    it(`${id} : plugin, avatar.json et dessin avec l'interface complète`, () => {
      expect(plugin.manifest.id).toBe(`avatar-${id}`);
      const root = fileURLToPath(new URL(`../../../avatar/${id}/`, import.meta.url));
      const a = readAvatarDir(root);
      expect(a.id).toBe(id);
      expect(a.emotions.length).toBeGreaterThan(5);
      // L'interface peut venir en partie du « vivant » commun (renderer/life.js, copie de scripts/avatar/life.js).
      const life = new URL("life.js", a.url);
      const src = readFileSync(new URL(a.url), "utf8") + (existsSync(life) ? readFileSync(life, "utf8") : "");
      for (const fn of ["setState", "setEmotion", "setLevel", "setMood", "lookAt", "setHearing", "cue", "destroy"]) expect(src).toContain(`${fn}(`);
      expect(src).toContain("webgl2");
    });
  }
});
