# AGENTS.md

Floppy: a local-first voice assistant where everything is a plugin. TypeScript (Node 24) kernel and plugins, Electron desktop app, Python voice service.

## Done means green

A change is done when `npm run check` passes (typecheck + Vitest + licence check) and every behaviour you changed has a test next to it. Network providers are tested with simulated responses.

## Architecture rules

- **Plugin first.** A new capability is a plugin in `plugins/<family>/<name>`, registered in `apps/cli/src/catalog.ts` and listed in `floppy.example.yml`. Plugins written by others (third-party: `floppy-plugin.json`, isolated process, AI review) follow `docs/spec/plugins-tiers.md`; their types live in `packages/sdk/floppy-plugin.d.ts`. The kernel (`packages/core`) stays free of Electron and of any specific plugin (`packages/core/test/boundaries.test.ts` guards this).
- **Plugins declare** the services they provide and inject, their permissions, settings (`ctx.settings.declare`) and settings forms (`ctx.items.declare`, `providerConfig`). The Settings window is generated from these declarations.
- **Tools carry a level** (`read`, `write`, `send`, `delete`, `physical`). Anything above `read` goes through approvals in the kernel; a plugin never asks the user itself.
- **Heavy resources run on demand.** A model on the GPU or a local voice is offered with `ctx.offer` and runs only while a slot uses it.
- **Before reworking a subsystem**, read its spec from `docs/spec/README.md` (French) and update the spec with the behaviour.
- **Before changing UI** (windows, Settings, avatars), read `DESIGN.md`: tokens, components and rules of the shipped interface.

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
- Secrets go through `ctx.secrets` / `providerConfig` into the OS keychain, never into YAML or logs.
- `floppy.yml` is the user's own config (git-ignored, created from `floppy.example.yml`). Defaults change in `floppy.example.yml`; `apps/cli/test/example-config.test.ts` validates it.
- Examples use neutral placeholders (`contoso`, `C:/models/…`, `~/Notes`).

## Dependencies

Exact versions (`save-exact`). Shipped packages need a permissive licence (`npm run licences` lists them).
