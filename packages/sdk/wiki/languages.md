# Two languages
> Everything the user reads or hears exists in French and English.

- Write `{ fr: "…", en: "…" }` for: the manifest `description`, setting `label` and `description`, `group`,
  option `label`, the `text` returned by a tool, `summary`, sections. Floppy picks the language.
- A plain string is read as French. Avoid it for what the user sees.
- A tool `description` is read by the model only: one language is enough (French is the house style).
- `initiative` (`ctx.emit`): `text` is a plain string. Write it in the user's language.
- Simple, short sentences. Never name an operating system ("the system password vault").
- Words recognised by voice (`aliases`): include both languages.
