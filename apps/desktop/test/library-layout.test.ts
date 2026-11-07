import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("la bibliothèque défile jusqu'au dernier modèle sans écraser les cartes des autres sections", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "floppy-library-layout-"));
  try {
    const electron = createRequire(import.meta.url)("electron") as string;
    const output = execFileSync(electron, [join(here, "library-layout.fixture.cjs"), resolve(here, "../src/renderer"), scratch,
      ...(process.platform === "linux" ? ["--ozone-platform=headless", "--no-sandbox"] : [])],
    { timeout: 25000, encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    const results = JSON.parse(output.match(/LAYOUT_RESULT=(.+)/)![1]!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result, `${result.width} × ${result.height}`).toMatchObject({ clipped: 0, scrollable: true, lastVisible: true });
      expect(result.scrollTop).toBeGreaterThan(0);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30000);
