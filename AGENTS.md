# AGENTS.md

Floppy: a local-first voice assistant where everything is a plugin. TypeScript (Node 24) kernel and plugins, Electron desktop app. Local models run as native programs (llama-server, audio.cpp) or in-process (sherpa-onnx).

## Done means green

A change is done when `npm run check` passes (typecheck + Vitest + licence check) and every behaviour you changed has a test next to it. Network providers are tested with simulated responses.

## Architecture rules

- **Plugin first.** A new capability is a plugin in `plugins/<family>/<name>`, registered in `apps/cli/src/catalog.ts` (`PACKAGES`) and listed in `floppy.example.yml`. Plugins written by others (third-party: `floppy-plugin.json`, isolated process, AI review) follow `docs/spec/plugins-tiers.md`; their types live in `packages/sdk/floppy-plugin.d.ts`. The kernel (`packages/core`) stays free of Electron and of any specific plugin (`packages/core/test/boundaries.test.ts` guards this).
- **Service contracts live by domain** in `packages/contracts/src` (one file per domain, each adds its services to the kernel's `Services` by module augmentation). The kernel keeps only its own (`task`, `documents`). Plugins import service types from `@floppy/contracts`; a new service extends a domain file, never `packages/core`. Who provides and uses each service: the generated map in `docs/spec/noyau.md` (refresh with `npm run docs:services` after changing a manifest or a contract).
- **Kernel layout.** `ctx` is typed in `packages/core/src/plugin/context.ts` and built in `plugin/context-factory.ts`; `kernel.ts` keeps the lifecycle. Modules split out of a large file get their needs declared (`plugin/kernel-internals.ts`, `*Deps` interfaces): see "Dette d'architecture" in `docs/spec/noyau.md`.
- **Desktop app: all TypeScript, windows and preloads compiled.** The main process (`apps/desktop/src/*.ts`: `main.ts`, `windows.ts`, `typer.ts`…) is TypeScript run by Electron without a build step (type stripping, like the kernel: erasable syntax only, `.ts` in relative imports). Windows (`src/renderer/*.ts`, run by Chromium) and preloads (`src/preload*.cts`, CommonJS in the sandboxed preload environment) are compiled by `tsc` into `apps/desktop/build/` (git-ignored): `npm run build:ui` (also run by `npm start`) builds once, `npm run dev:ui` rebuilds on save (relaunch the window to see a change). The build script (`scripts/build-ui.mjs`) also copies the static files of the pages (`*.html`, `*.css`, `vendor/**`): a new page or asset needs nothing more as long as it lives in `src/renderer`, but `main.ts` only loads it through `ui.ts` (`pageFile`, `preloadFile`). `npm run typecheck` checks the three projects (main process, `tsconfig.renderer.json` with DOM types, `tsconfig.preload.json` with Electron types). Window code imports siblings with `./x.ts` (rewritten to `.js` in the build). What preloads expose to pages is typed once in `renderer/bridge.d.ts`; kernel payloads are described in `renderer/types-*.d.ts`. `build-ui.test.ts` builds into a temp folder and checks that every file a page references exists. `lifecycle.test.ts` runs `main.ts` (types stripped) without its imports, so a new module imported by `main.ts` is also added to that test's context.
- **The Settings window draws with Preact** (`renderer/vendor/preact.mjs`, a byte-for-byte copy refreshed by `npm run vendor -w @floppy/desktop`, typed by `vendor/preact.d.mts`). Describe what it shows with `h()` from `dom.ts`, change the state in `settings-state.ts`, then call `render()`: never change its page by hand (an `island()` is the one exception, e.g. the voice recorder). `settings.ts` is the entry point; each `settings-*.ts` module holds one part (pages, slots, rows, detail page, in-place form, dialogs). `settings-window.test.ts` runs the real window in happy-dom from the sources.
- **Plugins declare** the services they provide and inject, their permissions, settings (`ctx.settings.declare`) and settings forms (`ctx.items.declare`, `providerConfig`). The Settings window is generated from these declarations.
- **Tools carry a level** (`read`, `write`, `send`, `delete`, `physical`). Anything above `read` goes through approvals in the kernel; a plugin never asks the user itself.
- **Before reworking a subsystem**, read its spec from `docs/spec/README.md` (French) and update the spec with the behaviour.
- **Before changing UI** (windows, Settings, avatars), read `DESIGN.md`: tokens, components and rules of the shipped interface.

## Plugin lifecycle (Cordis rules)

Before changing the kernel or how a plugin starts, stops or fails, read `docs/spec/noyau.md` (lifecycle rules).

- **Everything through `ctx`.** Start programs with `ctx.spawn` (long-running; `keep: true` for a browser or terminal opened for the user) or `ctx.exec` (short command with a timeout); open timers, listeners and servers with `ctx.interval`, `ctx.timeout`, `ctx.on`, `ctx.effect`. The kernel checks `permissions.exec`, closes everything when the plugin stops, and kills programs left over from a forced stop. `boundaries.test.ts` refuses `node:child_process` in plugin sources.
- **Host through `ctx.host`.** A plugin talks to the desktop app only through `ctx.host` (undefined on the command line), never through a process global.
- **Short `apply`.** `apply` declares and returns. Slow work (remote connections, model loading) runs in an `ctx.offer` fork or in the background after `apply`.
- **Heavy resources on demand.** A model on the GPU or a local voice is offered with `ctx.offer` and runs only while a slot uses it.
- **Fail loudly, recover alone.** A plugin that loses its resource calls `ctx.fail(T(…))`; the error shows in the app and the kernel retries with backoff. A local server starts with `startLocalServer` (waits for `/health`, then watches it). A borrower listens to `lost` and borrows again.
- **Network through `ctx.fetch`.** It adds a 30 s default timeout and reports hosts missing from `permissions.net`.
- **Bounded waits.** Every wait has a limit: `ctx.exec` and `ctx.fetch` set one, other waits use `AbortSignal.timeout`. `apply` has 60 s (`manifest.startTimeout_s`), a fork's `start` 600 s (`OfferDef.startTimeout_s`).
- **Reuse first.** Agents launched from a plugin take their environment, Codex overrides and JSON parsing from `@floppy/agent-cli`; files, local servers, item secrets and processes from `@floppy/core` (`writeJsonAtomic`, `startLocalServer`, `itemSecret`, `findExe`, `killTree`).
- **Safe files.** User data is written with `writeFileAtomic` / `writeJsonAtomic` and read with `readJsonFile`: a crash never leaves half a file, and a file that does not parse is set aside and reported.

## Two languages, everywhere

Every text a user reads or hears exists in French and English.

- Text for the user: `T("…fr…", "…en…")` from `@floppy/core`. Labels, descriptions, `OpResult.text`, approval summaries, wait phrases and tool results accept it; the kernel picks the language.
- What Floppy says or writes (speech, prompts that set the reply language, digests, messages it sends): `ctx.assistant.language`.
- What a window shows from plugin code: `ctx.uiLang()`.
- Errors that reach the user: `throw new TextError(T(…))`.
- Words recognised orally (aliases, yes/no, commands): accept both languages.
- French stays the default. Code comments, logs and tool descriptions read only by the model are written in French.

## Portable and neutral

- Text the user sees names no operating system: "the system password vault", "start with the computer", "the program". Shortcuts read `Ctrl+Alt+…` and the app shows `⌃⌥` on macOS.
- Paths to programs and models are settings with a portable default (`findExe("llama-server")` looks in the PATH). Code and committed config hold no absolute or machine-specific path.
- Secrets go through `ctx.secrets` / `providerConfig` / `itemSecret` into the OS keychain, never into YAML or logs.
- Everything Floppy keeps lives in its working folder (`ctx.home`; default `%LOCALAPPDATA%\floppy`, chosen in Welcome or Settings, see `packages/core/src/util/home.ts`): `floppy.yml`, settings, models, third-party plugins, logs. A plugin writes its files there, and an agent it launches works in `ctx.workspace()`.
- `floppy.yml` is the user's own config, created in the working folder from `floppy.example.yml`. Defaults change in `floppy.example.yml`; `apps/cli/test/example-config.test.ts` validates it.
- Examples use neutral placeholders (`contoso`, `C:/models/…`, `~/Notes`).

## Dependencies

Exact versions (`save-exact`). Shipped packages need a permissive licence (`npm run licences` lists them).
