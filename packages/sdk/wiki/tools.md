# Tools
> What the assistant can call: name, description, schema, level, handler.

```ts
ctx.tools.register([{
  name: "water_reminder",                     // snake_case, unique across Floppy: prefix it with the plugin id
  description: "Programme un rappel pour boire de l'eau dans N minutes.",   // read by the model only (French is the house style)
  inputSchema: {
    type: "object",
    properties: { minutes: { type: "number", minimum: 1, maximum: 240, description: "délai en minutes" } },
    required: ["minutes"],
  },
  level: "read",
  async handler(args) {
    const minutes = Number(args.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
      return { status: "failed", text: { fr: "Il faut un délai entre 1 et 240 minutes.", en: "The delay must be 1 to 240 minutes." } };
    }
    ctx.timeout(() => ctx.emit("initiative", { source: "water", text: "Time to drink a glass of water.", importance: "important" }), minutes * 60_000);
    return { status: "done", text: { fr: `Rappel dans ${minutes} minutes.`, en: `Reminder in ${minutes} minutes.` } };
  },
}]);
```

## Levels

The level decides whether the user is asked first. The kernel asks; a plugin never asks by itself.

| Level | For | Approval |
|---|---|---|
| `read` | reading, computing, no effect for the user | no |
| `write` | creating or changing something for the user | per the user's rules |
| `send` | sending something out (message, mail, request that publishes) | yes by default |
| `delete` | deleting | always |

Pick the most careful level that fits. When in doubt, go one level up.
A tool that sends a message (service `notify`) is `send`.

## Rules

- Validate `args`: they come from a model and can be wrong.
- `status`: `done`, `unverified` (done without proof), `failed`, `refused`.
- `text`: short, in both languages (page `languages`). The model reads it and says it again.
- `summary(args)` (optional): the sentence of the approval request, in both languages.
- The handler also gets `meta` (`signal` to cancel, `caller`, `origin`).
- Page `existing-tools` lists the tools already there: do not duplicate one.
