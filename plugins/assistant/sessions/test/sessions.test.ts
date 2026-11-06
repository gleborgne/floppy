// Plugin agent-sessions : ouvre une session de CLI dans un terminal, après accord ; la consigne passe par un fichier.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createSessionsPlugin, cliArgs, sessionFolderName, startPrompt, type Launcher } from "../src/index.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(approve = true) {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  // Faux programmes : il suffit qu'ils existent.
  const exe = (n: string) => { const f = join(dir, `${n}.exe`); writeFileSync(f, ""); return f; };
  const launched: { dir: string; title: string; cmd: string; args: string[] }[] = [];
  const launcher: Launcher = async (d, title, cmd, args) => { launched.push({ dir: d, title, cmd, args }); };
  const k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [createSessionsPlugin(launcher)] });
  kernels.push(k);
  k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, approve, "test"); });
  await k.applyConfig({ plugins: [{ id: "sessions", plugin: "agent-sessions", config: {
    dossier: join(dir, "travaux"), claudeExe: exe("claude"), codexExe: exe("codex"), agyExe: exe("agy"),
  } }] });
  return { k, launched, dir };
}

describe("sessions d'agent", () => {
  it("Claude avec Opus : accord, dossier neuf, consigne dans un fichier, phrase fixe au CLI", async () => {
    const { k, launched, dir } = await start();
    const consigne = "Analyse les bugs des 3 derniers mois ; fais-moi un artefact. & del C:\\ \"rm -rf\"";
    const r = await k.tools.call("ouvrir_session_agent", { agent: "claude", modele: "Opus", consigne });
    expect(r.status).toBe("done");
    expect(launched).toHaveLength(1);
    const l = launched[0]!;
    expect(l.cmd).toBe(join(dir, "claude.exe"));
    expect(l.dir.startsWith(join(dir, "travaux"))).toBe(true);
    expect(existsSync(l.dir)).toBe(true);
    expect(l.args.slice(0, 2)).toEqual(["--model", "opus"]);
    // Le texte dicté n'est jamais passé au terminal : seulement une phrase qui désigne le fichier.
    const prompt = l.args.at(-1)!;
    expect(prompt).not.toContain("rm -rf");
    expect(prompt).not.toContain(";");
    const file = prompt.match(/fichier (.+\.md)/)![1]!;
    expect(file.startsWith(join(dir, "home", "sessions"))).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(consigne);
  });

  it("refus de l'accord : rien n'est lancé", async () => {
    const { k, launched } = await start(false);
    const r = await k.tools.call("ouvrir_session_agent", { agent: "codex", consigne: "Fais un PPT du bilan semestriel" });
    expect(r.status).not.toBe("done");
    expect(launched).toHaveLength(0);
  });

  it("dossier donné : doit exister ; modèle et agent vérifiés", async () => {
    const { k, launched, dir } = await start();
    expect((await k.tools.call("ouvrir_session_agent", { agent: "codex", consigne: "x", dossier: join(dir, "absent") })).status).toBe("failed");
    expect((await k.tools.call("ouvrir_session_agent", { agent: "claude", consigne: "x", modele: "opus; calc" })).status).toBe("failed");
    expect((await k.tools.call("ouvrir_session_agent", { agent: "bash", consigne: "x" })).status).toBe("failed");
    expect(launched).toHaveLength(0);
    expect((await k.tools.call("ouvrir_session_agent", { agent: "antigravity", consigne: "x", dossier: dir, modele: "gemini-4-argon-medium" })).status).toBe("done");
    expect(launched[0]).toMatchObject({ dir, args: ["--model", "gemini-4-argon-medium", "-i", expect.any(String)] });
  });

  it("le résumé de l'accord dit l'agent, le modèle et le dossier", () => {
    expect(cliArgs("codex", "gpt-6.1-sol", "P")).toEqual(["-m", "gpt-6.1-sol", "P"]);
    expect(cliArgs("claude", undefined, "P")).toEqual(["P"]);
    expect(sessionFolderName("Analyse les bugs : 3 derniers mois !", new Date(2026, 10, 6, 18, 30))).toBe("2026-11-06-1830-analyse-les-bugs-3-derniers-mois");
    expect(startPrompt("C:/x.md", "en")).toContain("Read the file C:/x.md");
  });
});
