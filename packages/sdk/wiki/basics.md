# Plugin basics
> Folder layout, manifest, apply, cleanup. Read this first.

## Two kinds of plugins

| | Personal plugin | Third-party plugin |
|---|---|---|
| Where | `<home>/plugins/<id>/index.ts` | folder with a `floppy-plugin.json` |
| Written by | the user, or the AI assistant of the Settings window | someone else; installed after an AI review |
| Runs | inside the kernel, with full rights | in an isolated process |
| Floppy services (page `services`) | yes | no |

The AI assistant of the Settings window writes **personal plugins**.

## The index.ts file

```ts
import type { UserPlugin } from "../floppy-plugin.d.ts";   // the ONLY allowed import (erased at run time)

const plugin: UserPlugin = {
  manifest: {
    id: "water",                     // EXACTLY the folder name; ^[a-z][a-z0-9-]*$
    version: "0.1.0",
    licence: "MIT",
    description: { fr: "Rappelle de boire de l'eau.", en: "Reminds you to drink water." },
    permissions: {},                 // net: ["api.contoso.com"] if the plugin calls a website
  },
  apply(ctx) {
    // register tools, settings, timers… Everything must be able to stop (see "Cleanup").
  },
};
export default plugin;
```

- No run-time import: no `import x from "…"`, no `require`, no npm module, no `node:`.
  What you need is in `ctx`. Language built-ins (`fetch`, `Date`, `JSON`, `Intl`…) are allowed.
- `config` (optional): `{ parse(input) }` that validates the entry's config. Rarely useful: prefer settings.
- Manifest fields: `id`, `version`, `licence`, `description`, `permissions`, `sections` (settings sections),
  `inject` / `optional` (services used, page `services`).

## Cleanup

A plugin can be stopped or reloaded at any time. Everything it starts must stop:

- `ctx.interval(fn, ms)` and `ctx.timeout(fn, ms)`: stopped automatically. Do not call `setInterval` directly.
- `ctx.effect(() => …)`: cleanup for anything else (a connection, a subscription).
- `ctx.alive`: false once the plugin is stopped. Check it before acting in a late callback.
- No global state outside `apply`: it would survive the reload.

## Logs

- `ctx.log("info" | "warn" | "error" | "debug", message, data?)`: messages for the developer (shown by `test_plugin`).
- `ctx.audit.write({ kind: "<id>.<what>", ... })`: a record of what the plugin did. Never a secret.

## Errors

- An error thrown in `apply`: the plugin goes into error, visible in the settings.
- `ctx.fail(reason)` after start: the plugin stops, the error is visible.
- In a tool: return `{ status: "failed", text: … }` rather than throwing.

See also: `tools`, `settings`, `languages`, `events`, `services`, `security`, `testing`.
