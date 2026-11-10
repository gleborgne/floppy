# Events
> Listen (ctx.on) and emit (ctx.emit) on Floppy's bus.

| Event | Direction | Payload |
|---|---|---|
| `initiative` | emit | `{ source, text, importance: "important" \| "normal", key? }`: the assistant says something on its own. `important` = spoken as soon as possible + card; `normal` = card only. `key` avoids duplicates. |
| `task.done` | listen | `{ key, label, reason, result }`: a scheduled task finished (`result.summary`, `result.document`). |
| `plugin.state` | listen | `{ id, plugin, state, error? }`: a plugin changes state. |
| `service.changed` | listen | `{ name, provider? }`: a service has a new provider. |

```ts
ctx.on("task.done", ({ result }) => { ctx.log("info", `task done: ${result.summary}`); });
ctx.emit("initiative", { source: "water", text: "Remember to drink a glass of water.", importance: "normal", key: "water" });
```

- Subscriptions stop with the plugin.
- For a regular reminder: `ctx.interval(() => ctx.emit("initiative", …), minutes * 60_000)`.
