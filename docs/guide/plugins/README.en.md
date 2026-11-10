# Writing a Floppy plugin

*Français : [README.md](README.md)*

This guide shows how to write a plugin, try it, then share it with others.
A plugin adds a capability to Floppy: tools the assistant can call, and settings.

- The types are in [`packages/sdk/floppy-plugin.d.ts`](../../../packages/sdk/floppy-plugin.d.ts). That file is the full reference.
- There are two examples in [`packages/sdk/examples`](../../../packages/sdk/examples): a timer, and a weather plugin that uses the network.
- To learn how Floppy checks and isolates a plugin, see the spec [Third-party plugins](../../spec/plugins-tiers.md) (in French).

## Start in 5 minutes

```sh
floppy plugin new my-plugin          # creates the my-plugin/ folder from the template
floppy dev my-plugin                 # starts Floppy with this plugin
```

In another terminal:

```sh
floppy tool my_plugin_hello '{"name":"Ada"}' --home my-plugin/.floppy-dev
floppy chat --home my-plugin/.floppy-dev     # talk to Floppy with the keyboard
```

Edit `my-plugin/index.ts` and save. The plugin restarts by itself.

> `floppy` is the repository's CLI (`apps/cli/src/main.ts`). From the repository, `node apps/cli/src/main.ts <command>` does the same.

## What a plugin is

A plugin is a folder. It holds at least two files.

| File | Role |
|---|---|
| `floppy-plugin.json` | The identity card: id, version, licence, permissions. Floppy reads it **without running any code**. |
| `index.ts` | The code. It does `export default` of an object `{ manifest, config?, apply(ctx, config) }`. |
| `floppy-plugin.d.ts` | The types. The code imports them with `import type`, which is erased at run time. |
| `AGENTS.md`, `CLAUDE.md` | The rules for a coding agent (Claude Code, Codex) that helps you write the plugin. |

`apply(ctx, config)` runs when the plugin starts. It registers the plugin's tools and settings.

## The identity card

```json
{
  "id": "weather",
  "version": "1.0.0",
  "licence": "MIT",
  "api": 1,
  "description": { "fr": "La météo du moment.", "en": "The current weather." },
  "permissions": { "net": ["api.open-meteo.com"], "cloud": true }
}
```

- `id`: lowercase letters, digits and dashes. It starts with a letter. It is also the folder name once installed.
- `api`: the version of the plugin API. Today `1`.
- `permissions.net`: the hosts the plugin can reach. Without this list, it has no network access. `*.contoso.com` covers subdomains.
- `permissions.cloud`: the plugin sends user data to an online service.
- The code's `manifest` has **the same** `id`, `version` and `permissions`. Floppy compares both and refuses a difference.

## What `ctx` gives you

| Call | What for |
|---|---|
| `ctx.tools.register([...])` | Add tools. |
| `ctx.settings.declare([...])`, `ctx.settings.saved(key)` | Add settings; read back a kept value. |
| `ctx.emit("initiative", {...})` | Tell the user something on its own (a timer ends). |
| `ctx.on("service.changed", fn)` | Listen to an event. |
| `ctx.interval`, `ctx.timeout`, `ctx.effect` | Timers and clean-up, stopped by themselves when the plugin stops. |
| `ctx.log(level, message)`, `ctx.audit.write({...})` | Log. Never put a secret in it. |
| `ctx.alive`, `ctx.fail(reason)` | Know whether the plugin still runs; report a serious failure. |
| `fetch(url)` | Network, only to the hosts in `permissions.net`. |

## Tools

Each tool has a name, a description, a JSON schema for its parameters, a **level** and a `handler` function.

| Level | When | User approval |
|---|---|---|
| `read` | The tool only reads. | No |
| `write` | It creates or changes something for the user. | Yes, by default |
| `send` | It sends something out (a message, a request that publishes, data to a service). | Yes, by default |
| `delete` | It deletes. | Yes |

- Pick the most careful level that fits. When in doubt, go one level up.
- The plugin never asks for approval itself: Floppy does it, before it calls `handler`.
- Arguments come from a language model. Check them: type, length, bounds.
- `description` is read by the model only. One language is enough.

## Settings

A setting shows in the Settings window and can also be changed by voice.

- The key starts with the plugin id, dashes replaced by `_`. Example: `weather_unit` for the plugin `weather`.
- `type`: `enum`, `number`, `boolean` or `text`.
- `risk`: `free` (applied at once), `ask` (approval asked), `cli` (never by voice: click or CLI). Use `cli` for anything about permissions.
- `set(value)` checks the value before it applies it.
- The Settings window is built from these declarations. A plugin does not ship its own interface.

## Two languages

Every text a person reads exists in French and English: `{ fr: "…", en: "…" }`.

This covers labels, setting descriptions, options and the `text` a tool returns. Floppy picks the language. Spoken words (`aliases`) are accepted in both languages.

## What is not allowed, and why

A third-party plugin runs in a **separate process**, locked by Node's permission model. Floppy also checks the code before installing it (`floppy plugin check`).

| Not allowed | Why |
|---|---|
| `import` of a module (Node, npm); `require`; `import()` | The plugin must load nothing the review has not read. The plugin's own `.ts` files are still allowed. |
| Files, programs, native modules | The plugin's process has no right to them. |
| `eval`, `Function`, WebAssembly | Code built at run time escapes the review. |
| `fetch` without `permissions.net`, WebSocket | The network goes through Floppy, which checks each host, redirects included. |
| Minified code, invisible characters, `.js` | What is reviewed must be what runs. |
| `package.json` with dependencies or scripts | No npm package, no install script. |

The process has no environment variables. So it sees no key and no token.

## Debug mode

```sh
floppy dev <folder> [--inspect] [--home <folder>] [--config floppy.yml]
```

- The plugin is read where you write it. It is turned on at once.
- Each save restarts it. Its tools and settings are updated.
- Data goes to `<folder>/.floppy-dev`: your real config and settings do not change. `--home` picks another folder.
- The config used is `--config`, else `./floppy.yml`, else the one in the Floppy repository, else an empty config. With the repository's config, your usual brain answers in `floppy chat`.
- `floppy tool <tool> '<json>'` calls a tool without the model. If the tool needs approval, the question shows in the terminal.
- `--inspect` opens Node's debugger on the plugin process (port 9229). In VS Code, add an "attach" configuration:

  ```json
  { "type": "node", "request": "attach", "name": "Floppy plugin", "port": 9229 }
  ```

  Node cannot open the debugger and apply permissions at the same time. With `--inspect`, file isolation is lifted. Use this mode on your own code only.
- With the desktop app: `npm start -- --dev-plugin <folder>` (can be repeated).

## Check before you publish

```sh
floppy plugin check <folder>    # the checks run for the person who installs
floppy plugin test <folder>     # starts the plugin for 10 s in a throwaway kernel: state, tools, settings, log
```

## Publish and install

Publish the folder as a git repository, or as a `.zip` archive. The person who installs types:

```sh
floppy plugin install https://contoso.example/weather.git#v1.0.0
floppy plugin install C:/Downloads/weather.zip
```

They can also ask Floppy: "install the plugin https://…".

Then Floppy does this:

1. It copies the plugin into quarantine. Nothing runs.
2. It runs the automatic checks.
3. A coding agent reviews the code: Claude Code, Codex or Antigravity. **Without an installed agent, the installation is refused.** The setting "Third-party plugin reviewer" picks the agent.
4. The Settings window shows the report, in the Plugins section: "Install "weather"". One click installs the plugin. This click is never possible by voice.
5. The installed plugin stays off. A second click turns it on.

Floppy keeps the hash of the reviewed content. If a file changes after the installation, the plugin no longer starts. It must be installed again, and it is reviewed again.

Other commands: `floppy plugin list`, `floppy plugin approve <id>`, `floppy plugin remove <id>`.

## Let the AI assistant write the plugin

In the Settings window, AI assistant section, choose "Create a plugin" and describe what you want.
The agent (Claude Code or Codex) first reads the plugin wiki with the `plugin_docs` tool: the rules, the recipes, the exact contracts of Floppy's services, what is running now.
You see every file it writes before it is written. It tests the plugin, then you turn it on with a click.

You can read the wiki yourself too: [`packages/sdk/wiki`](../../../packages/sdk/wiki).

## Use Floppy's services (personal plugin)

A personal plugin can send a message (Telegram, mail), ask the model, search the web or show a document.
It declares the service in `optional` in its manifest, then borrows it for the time of a job. Recipes: [`packages/sdk/wiki/services.md`](../../../packages/sdk/wiki/services.md).
A third-party plugin has no access to services: it runs isolated.

## Personal plugin or third-party plugin

| | Personal plugin | Third-party plugin |
|---|---|---|
| Where | `<Floppy folder>/plugins/<id>/index.ts` | Installed by `floppy plugin install` |
| Written by | You, or the AI assistant of the Settings window | Someone else |
| `floppy-plugin.json` | No | Yes |
| Runs | In the kernel, with all its rights | In an isolated process |
| AI review | No | Yes, required |
| Floppy services (message, model, search) | Yes | No |

A folder with a `floppy-plugin.json` always runs isolated, even if copied by hand.
