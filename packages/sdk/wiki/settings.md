# Settings
> Values the user changes in the Settings window or by voice.

```ts
let every = ctx.settings.saved<number>("water_every") ?? 60;   // value kept from a previous start
ctx.settings.declare([{
  key: "water_every",                        // [a-z0-9_], starts with the plugin id (dashes → "_") then "_"
  section: "general",                        // section: "general", or a section from `manifest.sections`
  group: { fr: "Eau", en: "Water" },
  label: { fr: "Rappel toutes les", en: "Remind every" },
  description: { fr: "Minutes entre deux rappels.", en: "Minutes between two reminders." },
  type: "number", min: 15, max: 240,
  risk: "free",
  get: () => every,
  set: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 15 || n > 240) throw new Error("15 to 240"); every = n; },
}]);
```

- Types: `enum` (with `options: [{ value, label, aliases? }]`), `number` (`min`, `max`), `boolean`, `text` (`maxLength`).
- `set` applies at once. Validate the value. The kernel keeps it and returns it through `saved` on the next start.
- `aliases`: spoken words for an option, in both languages ("rapide", "fast").

## Risks

| Risk | Effect |
|---|---|
| `free` | applied at once, can be undone |
| `ask` | the app asks the user first (e.g. turning on something that leaves the computer) |
| `cli` | never by voice: the user clicks it. For anything about rights |

## Sections

A plugin can add its own section: `manifest.sections: [{ id: "water", label: { fr: "Eau", en: "Water" } }]`,
then `section: "water"` on its settings. For one or two settings, keep `"general"`.

The `lister_reglages` tool shows the existing settings and their keys.
