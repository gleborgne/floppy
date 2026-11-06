# Security

Floppy runs on your PC, starts programs (llama-server, the voice service, MCP servers, CLIs) and calls tools on your behalf.
Security bugs matter here. Thank you for reporting them privately.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/gleborgne/floppy/security/advisories/new).

Include what you did, what happened, and what you expected. A proof of concept helps, but is not required.
You should get a first answer within a week.

## Scope

Examples of what we want to hear about:

- A way to run a tool that writes, sends or deletes **without** the user's approval.
- A plugin, an MCP server, a web page, a document or a voice input that gets more rights than the user granted (prompt injection that crosses an approval, path escape, command injection).
- Secrets (API keys, tokens) leaking out of the OS keychain, into logs, into the config file or to another plugin.
- The local control endpoint (`127.0.0.1`, token in `control.json`) reachable or usable by another user or a web page.

The security model is described in [docs/spec/securite.md](docs/spec/securite.md) (French), including its known limits.

## Supported versions

Floppy is an early prototype: only the `main` branch is supported.
