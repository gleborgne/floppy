# Contributing

Thanks for your interest in Floppy. The project is an early prototype: issues and small pull requests are welcome.
For a bigger change, open an issue first so we can agree on the approach.

## Setup

```powershell
npm install
npm run check      # typecheck + tests + licence check — must pass before a pull request
npm start          # the desktop app
```

Local voice models and the benchmark (`bench`, Python) are optional: see the README.

## Guidelines

- **Everything is a plugin.** A new capability goes in `plugins/<family>/<name>`, not in the kernel (`packages/core`).
  The kernel has no dependency on Electron or on any specific plugin.
- **Plugins declare what they need**: services (`provides`, `inject`), rights (`permissions`), settings and settings forms.
  Tools have a level (`read`, `write`, `send`, `delete`); anything above `read` goes through approvals.
- **No machine-specific values in code.** Paths to programs or models are settings (form fields or `floppy.yml`), with a sensible default such as a lookup in the PATH.
- **No secrets in YAML or logs.** API keys and tokens go through the plugin's settings form into the OS keychain (`ctx.secrets`).
- **Tests.** Add or update tests next to the code (`test/` in each package or plugin, [Vitest](https://vitest.dev)).
  Network providers are tested with simulated responses.
- **Dependencies.** Exact versions (`save-exact`). Shipped packages must have a permissive licence (`npm run licences`).
- **Language.** The UI is bilingual (`{ fr, en }` texts). New docs and public files in English are welcome; existing docs are in French.

## Commits and pull requests

- One topic per pull request, with a short description of the why.
- Make sure `npm run check` passes.
- By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE).
