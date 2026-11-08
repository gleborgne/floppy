import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("le suivi réel garde sa liste et son détail lisibles en fenêtre compacte et étroite", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "floppy-tracking-layout-"));
  try {
    const built = join(scratch, "built");
    execFileSync(process.execPath, [resolve(here, "../scripts/build-ui.mjs"), "--out", built], { timeout: 170000, windowsHide: true });
    const electron = createRequire(import.meta.url)("electron") as string;
    const output = execFileSync(electron, [join(here, "tracking-layout.fixture.cjs"), built, scratch,
      ...(process.env.FLOPPY_TRACKING_CAPTURE ? [process.env.FLOPPY_TRACKING_CAPTURE] : []),
      ...(process.platform === "linux" ? ["--ozone-platform=headless", "--no-sandbox"] : [])],
    { timeout: 25000, encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    const { results, errors } = JSON.parse(output.match(/TRACKING_LAYOUT=(.+)/)![1]!);
    expect(errors).toEqual([]); expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ count: 4, horizontalOverflow: false, hasMission: true, boundedList: true, detailReachable: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180000);
