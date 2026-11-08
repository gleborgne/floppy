# Remember names that speech recognition gets wrong

Floppy can remember your explicit name corrections in context, such as a Teams channel or an Orca project. The local memory lives in your Floppy folder and works with the local brain, CLI agents and Live mode.

## Correct a name

If “Core Team” is transcribed as “court team”, say **“No, I meant Core Team.”** You can also type **“Correct court team to Core Team”** in the conversation when speech recognition keeps getting the corrected name wrong.

Specify the team or account if multiple channels share the name. A correction is remembered only after a successful tool write and can be used on subsequent requests. This does not retrain the speech model or replace words in message bodies or free dictation.

Ask “List my vocabulary corrections” to inspect them, or “Forget the correction from court team to Core Team” to remove one after approval. Changing an existing mapping requires an explicit correction and its current version.

## Enable it in an existing configuration

The example configuration includes the plugins and a narrowly scoped permission. Updates do not replace your existing `floppy.yml`. Merge these entries into your existing lists without replacing other settings:

```yaml
plugins:
  - { id: memory, plugin: memory }
  - { id: vocabulary, plugin: vocabulary }

approvals:
  write: ask
  send: ask
  delete: ask
  toolRules:
    - { source: vocabulary, tool: corriger_vocabulaire, level: write, rule: always }
```

Do not duplicate an existing memory entry. The permission's `source` must match the vocabulary plugin entry id. Without this permission, each correction requires approval. Other writes and sends keep their normal rules, and `write: never` still forbids memory writes.

In **Listening → Personal vocabulary**, turn off “Remember my corrections without asking again” to confirm each correction. This setting cannot grant a permission missing from the configuration. Forgetting a correction always requires approval.

Only the local provider is currently shipped. Future external providers can implement the independent memory contract; this feature requires support for structured vocabulary corrections.

## Audit behavior while Floppy is running

Run `floppy log 200` to read the latest 200 events. The current audit file is `audit.jsonl` in your Floppy folder; rotation keeps the previous file as `audit.1.jsonl`.

Follow events with the same `turn`, and tool operations with the same `callId`:

- `kind: "vocabulary"`: `correction.proposed`, `correction.accepted` or `correction.rejected` with a reason; `correction.forgotten`; `context.selected` with correction IDs and versions.
- `kind: "memory.store"`: durable local storage operations, including `correction.save`, their outcome and duration.
- `kind: "memory.context"`: context acquisition, outcome and `duration_ms`, including timeouts and cancellation.
- `approval` and `tool`: the kernel decision and actual tool outcome.

Selection means a correction was **provided to the brain**, not proof it was followed. Inspect tool calls from the same turn to understand the action attempted. Compare rejection reasons, latency and actual task outcomes across repeatable examples.

New diagnostics contain metadata by default. For a reproduction, enable **Listening → Personal vocabulary → Include correction text in the log**, then disable it afterwards. This adds bounded `correction.trace` events, not the full brain context. Disabling it does not erase earlier traces. Existing Floppy logs may already contain transcripts and other tool arguments; inspect logs before sharing them. Audit files rotate at a bounded size, so export events needed for longer comparisons.
