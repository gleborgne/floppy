// Les fenêtres de l'app (renderer/*.js) restent du JavaScript non typé : ce test vérifie au moins que chaque nom
// utilisé existe (import oublié après un découpage, variable renommée). TypeScript lit les fichiers sans les typer.
// Le processus principal (src/*.ts) est typé : `npm run typecheck` le vérifie.
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(ROOT, "apps", "desktop", "src");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

function unknownNames(files: string[], opts: string[]): string[] {
  let out = "";
  try {
    execFileSync(process.execPath, [TSC, "--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "es2022", ...opts, ...files], { cwd: ROOT, encoding: "utf8", timeout: 90_000 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  // TS2304 / TS2552 : nom introuvable ; TS2305 / TS2724 : nom absent du module importé.
  return out.split(/\r?\n/).filter((l) => /error TS(2304|2552|2305|2724)\b/.test(l));
}

it("fenêtre des réglages et ses modules : chaque nom utilisé existe", () => {
  const dir = join(SRC, "renderer");
  const files = readdirSync(dir).filter((f) => /^(settings.*|fields|dom)\.js$/.test(f) && f !== "settings-demo.js").map((f) => join(dir, f));
  expect(unknownNames(files, ["--module", "esnext", "--moduleResolution", "bundler", "--lib", "dom,es2023"])).toEqual([]);
}, 120_000);
