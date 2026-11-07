import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

it("la copie de Preact dans la fenêtre suit la version installée (sinon : npm run vendor -w @floppy/desktop)", () => {
  const root = dirname(createRequire(import.meta.url).resolve("preact/package.json"));
  const copy = readFileSync(resolve(here, "../src/renderer/vendor/preact.mjs"), "utf8");
  expect(copy === readFileSync(join(root, "dist", "preact.mjs"), "utf8")).toBe(true);
});
