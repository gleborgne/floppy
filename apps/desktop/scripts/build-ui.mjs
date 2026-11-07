// Compile les fenêtres (src/renderer/*.ts) et les preloads (src/preload*.cts) vers build/, puis y copie les fichiers
// statiques des pages (HTML, CSS, vendor/). Electron charge ses pages depuis build/ (src/ui.ts).
//   node scripts/build-ui.mjs            construit une fois (build/ est refait à neuf)
//   node scripts/build-ui.mjs --watch    reconstruit à chaque sauvegarde (tsc --watch + copie des fichiers statiques)
//   node scripts/build-ui.mjs --out <dossier>   construit ailleurs (tests)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const args = process.argv.slice(2);
const watching = args.includes("--watch");
const outArg = args.indexOf("--out");
const out = outArg >= 0 && args[outArg + 1] ? resolve(args[outArg + 1]) : join(desktop, "build");
const sources = join(desktop, "src", "renderer");
const target = join(out, "renderer");

/** Ce qui est copié tel quel depuis src/renderer : pas de TypeScript, pas de types. */
const isStatic = (name) => !/\.(ts|d\.ts|d\.mts)$/.test(name);

function copyStatic() {
  cpSync(sources, target, { recursive: true, filter: (p) => statSync(p).isDirectory() || isStatic(p) });
}

const projects = [
  { name: "fenêtres", config: "tsconfig.renderer.json", outDir: target },
  { name: "preloads", config: "tsconfig.preload.json", outDir: out },
];

function compile(project, extra = []) {
  return spawn(process.execPath, [tsc, "-p", join(desktop, project.config), "--outDir", project.outDir, ...extra], { cwd: desktop, stdio: "inherit" });
}

if (!watching) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyStatic();
  let failed = false;
  await Promise.all(projects.map((p) => new Promise((done) => compile(p).on("exit", (code) => { if (code) { failed = true; console.error(`build:ui : ${p.name} : tsc a échoué (code ${code})`); } done(); }))));
  if (failed) process.exit(1);
  console.log(`build:ui : ${out}`);
} else {
  mkdirSync(target, { recursive: true });
  copyStatic();
  for (const p of projects) compile(p, ["--watch", "--preserveWatchOutput"]);
  let timer;
  watch(sources, { recursive: true }, (_event, name) => {
    if (name && !isStatic(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { copyStatic(); console.log("build:ui : fichiers statiques copiés"); } catch (e) { console.error(e); } }, 100);
  });
  console.log("build:ui : surveillance (Ctrl+C pour arrêter). Relancer la fenêtre pour voir un changement.");
}
