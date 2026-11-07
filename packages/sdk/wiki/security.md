# Security
> Permissions, secrets, what is not allowed.

- **Network**: declare each host in `manifest.permissions.net` (e.g. `["api.contoso.com"]`). No list, no network.
  Set `cloud: true` if the plugin sends user data to the internet.
- **Secrets** (API key, token, password): never in the code, never in the conversation, never in the logs.
  A personal plugin has no secret form yet. If a secret is needed, tell the user:
  offer a `text` setting with risk `cli` that the user fills in, and warn that the value is not in the system password vault.
- **Files and programs**: a personal plugin runs with full rights. Do not use them: never read or write
  the files of other plugins or of the app, never start a program.
- **Tool levels**: never `read` for a tool that sends or changes something (page `tools`).
- **Turning on**: a personal plugin is turned on only by the user's click in the settings. You cannot turn it on.
