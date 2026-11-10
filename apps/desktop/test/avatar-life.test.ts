import { it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { AVATARS, SOURCE } from "../../../scripts/vendor-avatar-life.mjs";

const plugins = new URL("../../../plugins/avatar/", import.meta.url);

it.each(AVATARS)("%s : renderer/life.js est la copie exacte de scripts/avatar/life.js (sinon : npm run vendor:avatars)", (id) => {
  const copy = new URL(`${id}/renderer/life.js`, plugins);
  expect(existsSync(copy)).toBe(true);
  expect(readFileSync(copy, "utf8") === readFileSync(SOURCE, "utf8")).toBe(true);
});

it("tout avatar qui importe ./life.js est dans la liste des copies, et inversement", () => {
  const importing = readdirSync(plugins).filter(id => existsSync(new URL(`${id}/renderer/index.js`, plugins))
    && /from "\.\/life\.js"/.test(readFileSync(new URL(`${id}/renderer/index.js`, plugins), "utf8")));
  expect(importing.sort()).toEqual([...AVATARS].sort());
});
