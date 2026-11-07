# Using Floppy's services
> Send a message, ask the model, search the web, show a document. Personal plugins only.

A service is a capability provided by another plugin. The exact contract of each one: pages `contract-notify`,
`contract-completion`, `contract-search`, `contract-documents`. What is running now: page `active-services`.

## Declare

In the manifest:
- `optional: ["notify"]`: the plugin starts even without the service (recommended).
- `inject: ["documents"]`: the plugin WAITS for the service ("waiting" state while it is missing). Avoid unless really needed.

The kernel refuses a service that is not declared.

## Two ways to get it

1. **A single provider** (`documents`): `ctx.maybe("documents")` (undefined if missing) or `ctx.get("documents")` (with `inject`).
2. **Items to choose from** (`notify`: each Telegram or mail channel; `completion`: each model; `search`: each engine):
   - `ctx.offers("notify")` lists the items: `[{ value: "telegram/home", label, cloud?, entry }]`;
   - `ctx.borrowItem("notify", value)` borrows one item for the time of a job. Give it back with `release()`.
   - `borrowItem` runs AFTER `apply` (in a tool, a timer), never during it.

## Recipes

Send a message (first channel; tool level `send`):

```ts
// manifest.optional: ["notify"]
const channels = ctx.offers("notify");
if (!channels.length) return { status: "failed", text: { fr: "Aucun canal d'envoi. Ajoute Telegram ou un mail dans les réglages, rubrique Notifications.", en: "No sending channel. Add Telegram or a mail in Settings, Notifications section." } };
const b = await ctx.borrowItem("notify", channels[0].value);
if (!b) return { status: "failed", text: { fr: "Canal indisponible.", en: "Channel unavailable." } };
try { await b.service.send({ titre: "Reminder", markdown: "Drink a glass of water." }); }
finally { b.release(); }
```

To let the user pick the channel: an `enum` setting whose options come from `ctx.offers("notify")`
(`value` and `label`), read when sending.

Ask the model (summarise, sort, classify):

```ts
// manifest.optional: ["completion"]
const model = ctx.offers("completion")[0];
const b = model && await ctx.borrowItem("completion", model.value);
if (!b) return { status: "failed", text: { fr: "Aucun modèle disponible.", en: "No model available." } };
try {
  const r = await b.service.complete({ system: "Summarise in one sentence.", prompt: text });
  return { status: "done", text: r.text };
} finally { b.release(); }
```

If `cloud` is true on the item, the data goes to the internet: say so in the plugin description.

Search the web: same with `"search"` and `b.service.search("query", { max: 5 })`, which returns `[{ titre, url, resume?, source?, date? }]`.

Show a Markdown document (a Floppy window):

```ts
// manifest.optional: ["documents"]
const docs = ctx.maybe("documents");
if (docs) { const ref = await docs.save({ titre: "Summary", markdown: "# Summary\n…", source: "water" }); await docs.show(ref.id); }
```

Field names of the contracts are French (`titre`, `resume`): copy them as they are.

## Good to know

- The plugin restarts when an `optional` service arrives or changes: do not keep the service outside a call.
- Sending (notify) or using a `cloud` model leaves the user's computer: the tool that does it is level `send`.
- In `tester_plugin` (throwaway kernel) there are no services: `offers` returns an empty list. Handle that case.
