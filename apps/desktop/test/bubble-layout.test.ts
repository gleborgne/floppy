import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("une notification utilise la hauteur disponible et les longs textes restent entièrement accessibles", () => {
  const scratch = mkdtempSync(join(tmpdir(), "floppy-bubble-layout-"));
  try {
    const electron = createRequire(import.meta.url)("electron") as string;
    const output = execFileSync(electron, [resolve("apps/desktop/test/bubble-layout.fixture.cjs"), resolve("apps/desktop/src/renderer"), scratch,
      ...(process.platform === "linux" ? ["--ozone-platform=headless", "--no-sandbox"] : [])],
    { timeout: 25000, encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    const results = JSON.parse(output.match(/LAYOUT_RESULT=(.+)/)![1]!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result, `largeur ${result.width}`).toMatchObject({ normalClipped: false, listeningClipped: false, longScrollable: true, lastVisible: true });
      expect(result.bubbleTop).toBeGreaterThanOrEqual(0);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30000);
