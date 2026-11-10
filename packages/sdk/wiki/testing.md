# Testing and delivering
> The order of the steps, and common errors.

1. Write `<id>/index.ts` (the user sees every write first).
2. `test_plugin` with the id: it loads the plugin in a throwaway kernel (10 s) and returns the state, error, tools, settings and log.
3. Fix, then run `test_plugin` again until "OK".
4. `reload_plugins`: Floppy reads the folder again.
5. Tell the user to turn the plugin on with a click in the settings ("Plugins utilisateur" / "User plugins" group). You cannot turn it on.
6. `plugin_status` shows the state of each plugin if something does not start.

## Common errors

| Message | Cause |
|---|---|
| manifest id differs from the folder | the id must be exactly the folder name |
| forbidden import, module not found | a run-time import; only `import type` is allowed |
| `service X non déclaré dans inject/optional` | add the service to the manifest |
| `ctx.borrowItem se fait après apply` | borrow in a tool or a timer, not in `apply` |
| `waiting` state | an `inject` service is missing; prefer `optional` |
| 10 s timeout exceeded | `apply` is waiting for something; no long wait in `apply` |
