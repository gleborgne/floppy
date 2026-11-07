// Ce que partagent les plugins qui lancent un agent : environnement nettoyé, config de Codex, JSON d'une réponse.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, codexMcpOverrides, CODEX_FEATURES_OFF, parseModelJson, userCodexMcpNames } from "../src/index.ts";

describe("environnement d'un agent", () => {
  const env = { Path: "C:/bin", USERPROFILE: "C:/u", CLAUDECODE: "1", ORCA_TOKEN: "x", ANTHROPIC_API_KEY: "k", HOME: "/h", CODEX_HOME: "/c" };

  it("garde la liste de base (sans tenir compte de la casse), jamais une session parente ni une clé", () => {
    expect(agentEnv({}, { env })).toEqual({ Path: "C:/bin", USERPROFILE: "C:/u" });
  });

  it("ajoute, retire et complète", () => {
    expect(agentEnv({ FLOPPY_MCP_TOKEN: "t" }, { env, also: ["HOME", "CODEX_HOME"] })).toEqual({ Path: "C:/bin", USERPROFILE: "C:/u", HOME: "/h", CODEX_HOME: "/c", FLOPPY_MCP_TOKEN: "t" });
    expect(agentEnv({ USERPROFILE: "/isolé" }, { env, drop: ["USERPROFILE"] })).toEqual({ Path: "C:/bin", USERPROFILE: "/isolé" });
  });
});

describe("Codex", () => {
  it("coupe les fonctions et les serveurs de l'utilisateur ; seul le serveur Floppy reste", () => {
    const c = codexMcpOverrides({ mcpUrl: "http://127.0.0.1:1/mcp", tools: ["a", "b"], userMcp: ["github"], alsoOff: ["shell_tool"] }).join(" ");
    for (const f of [...CODEX_FEATURES_OFF, "shell_tool"]) expect(c).toContain(`features.${f}=false`);
    expect(c).toContain("mcp_servers.github.enabled=false");
    expect(c).toContain('mcp_servers.floppy={url="http://127.0.0.1:1/mcp",bearer_token_env_var="FLOPPY_MCP_TOKEN",tools={a={approval_mode="approve"},b={approval_mode="approve"}}}');
  });

  it("lit les serveurs MCP de ~/.codex/config.toml", () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-codex-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.github]\ncommand = "x"\n[mcp_servers."notes"]\n[other]\n');
    expect(userCodexMcpNames(home)).toEqual(["github", "notes"]);
    expect(userCodexMcpNames(join(home, "absent"))).toEqual([]);
  });
});

describe("JSON d'une réponse de modèle", () => {
  it("avec ou sans ```json, avec du texte autour, objet ou tableau", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('Voici :\n```json\n{"a":[1,2]}\n```\nVoilà.')).toEqual({ a: [1, 2] });
    expect(parseModelJson("Résultat : [1, 2] fin")).toEqual([1, 2]);
    expect(parseModelJson("pas de JSON")).toBeUndefined();
    expect(parseModelJson("{ cassé")).toBeUndefined();
  });
});
