import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { projectName, cleanTask, cleanMessage, isWorker, facts, plainSentence, llmSentence } from "../src/speech.ts";
import type { OrcaAgent, OrcaWorktree } from "../src/index.ts";

const w = (displayName: string, repo: string) => ({ worktreeId: "x", displayName, repo }) as OrcaWorktree;
const a = (o: Partial<OrcaAgent>) => ({ paneKey: "p", ...o }) as OrcaAgent;

describe("annonces Orca sans jargon (données réelles)", () => {
  it("noms de projet lisibles", () => {
    expect(projectName(w("master-differendum", "Differendum"))).toBe("Differendum");
    expect(projectName(w("dev-mcp", "extensions"))).toBe("Extensions");
    expect(projectName(w("voicefun", "voicefun"))).toBe("Voicefun");
    expect(projectName(w("master-agents", "agents"))).toBe("Agents");
  });

  it("tâches et workers", () => {
    expect(cleanTask(a({ taskTitle: "fo: bug SSR bloc Custom Entity + PR env-stg", conversationName: "worker-task_1bb07be677c3" }))).toBe("bug SSR bloc Custom Entity");
    expect(cleanTask(a({ conversationName: "worker-task_1bb07be677c3" }))).toBe("");
    expect(cleanTask(a({ conversationName: "Job 59776 en erreur" }))).toBe("Job 59776 en erreur");
    expect(isWorker(a({ conversationName: "worker-task_1bb07be677c3" }))).toBe(true);
    expect(isWorker(a({ prompt: "You have 1 orchestration message. Run `orca orchestration check`." }))).toBe(true);
    expect(isWorker(a({ conversationName: "Bouton Nettoyer" }))).toBe(false);
  });

  it("dernier message sans code, chemins ni hash", () => {
    const m = cleanMessage("I committed and pushed `pnpm clean` to `master`, as commit `0f0c71f`. See C:\projects\staging\fo and **done**.");
    expect(m).not.toMatch(/0f0c71f|C:\|\*\*|`/);
  });

  it("phrase sans LLM", () => {
    const f = facts(w("master-differendum", "Differendum"), a({ conversationName: "Réponse aux commentaires dans les PR" }), "termines");
    expect(plainSentence(f)).toBe("Sur Differendum, ton agent a fini : réponse aux commentaires dans les PR.");
  });

  it("phrase du LLM local ; repli si lent ou absent", async () => {
    let body = "";
    const srv = createServer((req, res) => {
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "« Sur Differendum, la version 1.0.19 est publiée. »" } }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const f = facts(w("master-differendum", "Differendum"), a({ lastAssistantMessage: "Differendum 1.0.19 is published." }), "termines");
    expect(await llmSentence({ baseURL: `http://127.0.0.1:${port}/v1`, model: "m" }, f)).toBe("Sur Differendum, la version 1.0.19 est publiée.");
    expect(body).toContain("Differendum 1.0.19 is published");
    srv.close();
    expect(await llmSentence(undefined, f)).toBeUndefined();
    expect(await llmSentence({ baseURL: "http://127.0.0.1:1/v1", model: "m" }, f, 500)).toBeUndefined();
  });
});

describe("annonces Orca en anglais", () => {
  it("phrase faite par le code et consigne du LLM dans la langue de l'assistant", async () => {
    const { llmPrompt } = await import("../src/speech.ts");
    const f = facts(w("env-stg", ""), a({ taskTitle: "Fix login" }), "en_attente", "en");
    expect(f.lang).toBe("en");
    expect(plainSentence(f)).toBe("On Stg, your agent is waiting for your answer: Fix login.");
    expect(plainSentence(facts(w("", ""), a({}), "termines", "en"))).toBe("On a project, your agent is done.");
    expect(llmPrompt(f)).toContain("natural spoken English");
    // Par défaut : français, comme avant.
    expect(plainSentence(facts(w("", ""), a({}), "termines"))).toBe("Sur un projet, ton agent a fini.");
  });
});
