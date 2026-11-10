import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { projectName, cleanTask, cleanMessage, isWorker, facts, plainSentence, completionSentence, waitingSentence, llmSentence, llmPrompt } from "../src/speech.ts";
import type { OrcaAgent, OrcaWorktree } from "../src/index.ts";

const w = (displayName: string, repo: string) => ({ worktreeId: "x", displayName, repo }) as OrcaWorktree;
const a = (o: Partial<OrcaAgent>) => ({ paneKey: "p", ...o }) as OrcaAgent;

describe("notifications de fin synthétiques", () => {
  const f = { ...facts(w("Floppy", "Floppy"), a({}), "termines"), label: "Correction des notifications", outcome: "unknown" as const };
  it("nomme le travail une seule fois sans métadonnées ni extrait de rapport", () => {
    expect(completionSentence({ ...f, last: "Rapport très détaillé. ".repeat(30) })).toBe("Correction des notifications : terminé.");
    expect(completionSentence({ ...f, lang: "en" })).toBe("Correction des notifications : finished.");
  });
  it.each([
    ["success", "terminé avec succès", "completed successfully"],
    ["failure", "échec", "failed"],
    ["interruption", "interrompu", "interrupted"],
    ["unconfirmed", "terminé, résultat à vérifier", "finished, result to verify"],
  ] as const)("préserve le résultat %s dans les deux langues", (outcome, fr, en) => {
    expect(completionSentence({ ...f, outcome })).toBe(`${f.label} : ${fr}.`);
    expect(completionSentence({ ...f, outcome, lang: "en" })).toBe(`${f.label} : ${en}.`);
  });
  it("ne reprend jamais la réponse de l'agent, même en cas de réussite", () => {
    expect(completionSentence({ ...f, outcome: "success", last: "Les tests passent. Voici les modifications…" })).toBe(`${f.label} : terminé avec succès.`);
  });
  it("borne les titres longs", () => {
    expect(completionSentence({ ...f, label: "Titre ".repeat(50) }).length).toBeLessThan(160);
  });
  it.each([
    ["waiting-input", undefined, "votre réponse", "your answer"],
    ["permission", undefined, "votre validation", "your approval"],
    ["waiting", "approval", "votre validation", "your approval"],
    ["blocked", undefined, "votre intervention", "your intervention"],
  ])("nomme le thread et le type d'attente %s sans relire le rapport", (state, tool, fr, en) => {
    const waiting = { ...f, last: "Voici tout le travail effectué. ".repeat(30) };
    expect(waitingSentence(waiting, state, tool)).toBe(`${f.label} : l’agent attend ${fr}.`);
    expect(waitingSentence({ ...waiting, lang: "en" }, state, tool)).toBe(`${f.label} : the agent is waiting for ${en}.`);
  });
});

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
  it.each(["fr", "en"] as const)("préserve le nom individuel et ne transforme pas une fin inconnue en succès (%s)", (lang) => {
    const f = { ...facts(w("Floppy", "Floppy"), a({ taskTitle: "Courrier" }), "termines", lang), label: "Courrier", outcome: "unknown" as const };
    expect(plainSentence(f)).toContain("Courrier");
    expect(plainSentence(f)).toContain(lang === "en" ? "unknown result" : "résultat inconnu");
    expect(llmPrompt(f)).toContain(lang === "en" ? "Finished does not mean successful or committed" : "Une fin ne prouve ni réussite ni commit");
    expect(plainSentence({ ...f, outcome: "failure" })).toContain(lang === "en" ? "failure" : "échec");
  });
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
