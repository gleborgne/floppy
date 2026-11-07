// Profils privés : aucun fichier d'authentification ni réglage global du CLI n'est copié.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { writeFileAtomic, writeJsonAtomic, TextError, T } from "@floppy/core";
import type { McpEndpoint } from "@floppy/contracts";
import { agentEnv } from "./index.ts";
import type { AgentCommand, WireEvent } from "./stream.ts";

export type AgentProtocol = "opencode" | "pi" | "omp" | "hermes";
export interface ProfileInput {
  protocol: AgentProtocol; home: string; cwd: string; system: string; prompt: string;
  model: string; provider: string; apiKeyEnv: string; apiKey?: string; mcp: Pick<McpEndpoint, "url" | "token">;
  tools: string[];
}

/** Une configuration administrée pourrait charger du code avant nos règles ; refus du mode piloté. */
export function openCodeSystemConfigPaths(env = process.env, platform = process.platform): string[] {
  if (platform === "win32") return [join(env.ProgramData ?? env.PROGRAMDATA ?? "C:/ProgramData", "opencode")];
  if (platform === "darwin") return ["/Library/Application Support/opencode", `/Library/Managed Preferences/${userInfo().username}/ai.opencode.managed.plist`, "/Library/Managed Preferences/ai.opencode.managed.plist"];
  return ["/etc/opencode"];
}

export function prepareAgentProfile(o: ProfileInput): AgentCommand {
  if (o.protocol === "opencode" && openCodeSystemConfigPaths().some((path) => existsSync(path))) {
    throw new TextError(T("Une configuration administrée d'OpenCode empêche de garantir ses outils. Utilise une session interactive.", "An administered OpenCode configuration prevents tool isolation. Use an interactive session."));
  }
  const env = agentEnv({
    HOME: o.home, USERPROFILE: o.home,
    XDG_CONFIG_HOME: join(o.home, "config"), XDG_DATA_HOME: join(o.home, "data"), XDG_CACHE_HOME: join(o.home, "cache"),
    FLOPPY_MCP_TOKEN: o.mcp.token,
    ...(o.apiKey ? { [o.apiKeyEnv]: o.apiKey } : {}),
  }, { drop: ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"] });
  env.APPDATA = join(o.home, "config"); env.LOCALAPPDATA = join(o.home, "data");
  const system = join(o.cwd, "floppy-system.md");
  writeFileAtomic(system, o.system);
  const remote = { type: "http", url: o.mcp.url, headers: { Authorization: "Bearer ${FLOPPY_MCP_TOKEN}" } };
  const model = o.model ? ["--model", o.model] : [];
  const provider = o.provider ? ["--provider", o.provider] : [];
  switch (o.protocol) {
    case "pi": {
      env.PI_CODING_AGENT_DIR = o.home;
      env.PI_TELEMETRY = "0"; env.PI_SKIP_VERSION_CHECK = "1";
      writeJsonAtomic(join(o.home, "mcp.json"), { autoEnableCodemode: false, mcpServers: {
        floppy: { ...remote, exposure: "direct", timeout: 30 },
      } });
      return { env, cwd: o.cwd, stdin: o.prompt, args: ["--mode", "json", "--print", "--no-session", "--no-approve",
        "--no-extensions", "-e", "builtin:mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
        "--tools", "mcp__floppy__*", "--system-prompt", system, ...provider, ...model] };
    }
    case "omp": {
      env.PI_CODING_AGENT_DIR = o.home; env.OMP_MCP_REQUIRE_READY = "1";
      writeJsonAtomic(join(o.home, "mcp.json"), { mcpServers: { floppy: { ...remote, timeout: 30000 } } });
      const overlay = join(o.home, "floppy.yml");
      writeFileAtomic(overlay, "mcp:\n  enableProjectConfig: false\nautolearn:\n  enabled: false\nmemory:\n  backend: off\n");
      return { env, cwd: o.cwd, stdin: o.prompt, args: ["--mode", "json", "--print", "--no-session", "--no-extensions",
        "--no-skills", "--no-rules", "--no-context-files", "--no-title", "--no-lsp", "--no-tools",
        "--config", overlay, "--system-prompt", system, ...provider, ...model] };
    }
    case "hermes": {
      env.HERMES_HOME = o.home;
      env.HERMES_MANAGED_DIR = join(o.home, "managed");
      writeJsonAtomic(join(env.HERMES_MANAGED_DIR, "config.yaml"), {});
      // JSON est un sous-ensemble de YAML ; aucune interpolation de consigne dans la configuration.
      writeJsonAtomic(join(o.home, "config.yaml"), {
        model: { ...(o.model ? { default: o.model } : {}), ...(o.provider ? { provider: o.provider } : {}) },
        memory: { memory_enabled: false, user_profile_enabled: false, nudge_interval: 0 },
        skills: { creation_nudge_interval: 0, external_dirs: [] },
        auxiliary: { title_generation: { enabled: false, model_upgrade_enabled: false }, background_review: { enabled: false } },
        compression: { enabled: false }, hooks: {}, agent: { max_turns: 30 }, platform_toolsets: { cli: ["floppy"] },
        mcp_servers: { floppy: { url: o.mcp.url, headers: remote.headers,
          tools: { include: o.tools }, prompts: false, resources: false } },
      });
      return { env, cwd: o.cwd, stdin: `${o.system}\n\n${o.prompt}`, args: ["chat", "--query-file", "-", "--format", "stream-json",
        "--oneshot", "--ignore-rules", "--toolsets", "floppy", ...provider, ...model] };
    }
    case "opencode": {
      env.OPENCODE_CONFIG_DIR = join(o.home, "config");
      env.OPENCODE_CONFIG_PROJECT_DISABLE = "1"; env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: { servers: { floppy: { type: "remote", url: o.mcp.url, oauth: false, codemode: false,
          headers: { Authorization: "Bearer {env:FLOPPY_MCP_TOKEN}" } } } },
        agents: { floppy: { description: "Assistant Floppy", mode: "primary", system: o.system, steps: 30, permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...o.tools.map((name) => ({ action: `floppy_${name}`, resource: "*", effect: "allow" })),
        ] } },
      });
      return { env, cwd: o.cwd, stdin: o.prompt,
        args: ["run", "--standalone", "--format", "json", "--agent", "floppy", ...model] };
    }
  }
}

export function parseAgentEvent(protocol: AgentProtocol, ev: any): WireEvent {
  if (protocol === "hermes") {
    if (ev.type === "text") return { text: ev.text };
    if (ev.type === "tool_use") return { tool: { name: ev.name, args: ev.input ?? {} } };
    if (ev.type === "tool_result") return { result: { name: ev.name, status: ev.is_error ? "failed" : "done" } };
    if (ev.type === "result") return { final: ev.text ?? "", complete: true, error: ev.error || (ev.exit_code ? String(ev.exit_code) : undefined) };
    if (ev.type === "error") return { error: ev.message ?? ev.error ?? "erreur" };
    return {};
  }
  if (protocol === "opencode") {
    if (ev.type === "text") return { text: ev.part?.text };
    if (ev.type === "tool_use") return { tool: { name: ev.part?.tool, args: ev.part?.state?.input ?? {} } };
    if (ev.type === "step_finish") return { complete: true };
    if (ev.type === "error") return { error: ev.error?.message ?? JSON.stringify(ev.error) };
    return {};
  }
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") return { text: ev.assistantMessageEvent.delta };
  if (ev.type === "tool_execution_start") return { tool: { name: ev.toolName, args: ev.args ?? {} } };
  if (ev.type === "tool_execution_end") return { result: { name: ev.toolName, status: ev.isError ? "failed" : "done" } };
  if (ev.type === "message_end" && ev.message?.role === "assistant") {
    const m = ev.message;
    if (m.stopReason === "error" || m.stopReason === "aborted") return { error: m.errorMessage ?? m.stopReason };
    return { final: (m.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(""), complete: m.stopReason === "stop" };
  }
  return {};
}

export function floppyToolName(protocol: AgentProtocol, name: string, tools: string[]): string | undefined {
  const prefix = { pi: "mcp__floppy__", omp: "mcp__floppy_", hermes: "mcp_floppy_", opencode: "floppy_" }[protocol];
  const tool = typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
  return tool && tools.includes(tool) ? tool : undefined;
}
