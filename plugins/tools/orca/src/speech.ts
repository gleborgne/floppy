// Annonces Orca en langage parlé. Les données d'Orca sont pleines de jargon : noms de worktree (« master-differendum »,
// « env-stg »), ids (« worker-task_1bb07be677c3 »), titres codés (« fo: bug SSR … + PR env-stg »), derniers
// messages en anglais avec hash de commit, chemins et markdown.
//
// 1. Nettoyage (toujours) : nom de projet lisible, ids retirés, workers d'orchestration repérés.
// 2. Phrase du LLM local (si disponible, 4 s max) : une phrase courte, parlée, sans jargon, dans la langue de
//    l'assistant (français ou anglais, Facts.lang).
//    Sinon : phrase faite par le code à partir du nettoyage.
import type { OrcaAgent, OrcaWorktree } from "./index.ts";

export type Kind = "en_cours" | "termines" | "en_attente" | "interrompu";

const ID_LIKE = /\b(worker-task|task|job|run)[_-]?[0-9a-f]{6,}\b|\b[0-9a-f]{7,40}\b/gi;
const BRANCH_PREFIX = /^(master|main|dev|develop|feature|feat|fix|hotfix|env|release|wt|worktree)[-_/]+/i;

/** « master-differendum » → « Differendum » ; « stg-fo » → « stg fo » ; garde le dépôt si le worktree est codé. */
export function projectName(w: OrcaWorktree, lang = "fr"): string {
  const pick = (s: string | undefined): string => {
    if (!s) return "";
    let x = s.trim();
    while (BRANCH_PREFIX.test(x)) x = x.replace(BRANCH_PREFIX, "");
    x = x.replace(ID_LIKE, "").replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
    return x ? x[0]!.toUpperCase() + x.slice(1) : "";
  };
  const fromName = pick(w.displayName);
  const fromRepo = pick(w.repo);
  // Le dépôt est souvent plus parlant (« Differendum ») qu'un nom de worktree court ou codé (« env stg »).
  if (fromRepo && (!fromName || fromName.length <= 4 || norm(fromRepo).includes(norm(fromName)) || norm(fromName).includes(norm(fromRepo)))) return fromRepo;
  return fromName || fromRepo || (lang === "en" ? "a project" : "un projet");
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/** Worker lancé par un coordinateur Orca : son « en attente » ne concerne pas l'utilisateur. */
export function isWorker(a: OrcaAgent): boolean {
  return /^worker-task[_-]/i.test(a.conversationName ?? "") || /orchestration/i.test(a.prompt ?? "");
}

/** Titre de la tâche, sans ids ni préfixes codés (« fo: »). Vide si rien de lisible. */
export function cleanTask(a: OrcaAgent): string {
  const raw = [a.taskTitle, a.conversationName, a.displayName].find((s) => s && !/^worker-task[_-]/i.test(s)) ?? "";
  return raw.replace(ID_LIKE, "").replace(/^[a-z]{1,5}:\s*/i, "").replace(/\s+\+\s+.*$/, "").replace(/\s+/g, " ").trim();
}

/** Dernier message réduit à du texte parlable (sans code, chemins, markdown, hash). */
export function cleanMessage(s: string | null | undefined, n = 400): string {
  if (!s) return "";
  const t = s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[A-Z]:\\[^\s]+|\/[\w.-]+(\/[\w.-]+)+/g, " ")
    .replace(ID_LIKE, " ")
    .replace(/[*#>_|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export interface Facts {
  project: string;
  task: string;
  /** Nom individuel stable, distinct du projet. */
  label?: string;
  outcome?: "success" | "failure" | "interruption" | "unconfirmed" | "unknown";
  kind: Kind;
  asked: string;
  last: string;
  /** Langue de l'assistant : langue de la phrase dite (défaut : français). */
  lang?: "fr" | "en";
}

export function facts(w: OrcaWorktree, a: OrcaAgent, kind: Kind, lang: "fr" | "en" = "fr"): Facts {
  return {
    ...(lang === "en" ? { lang } : {}),
    project: projectName(w, lang),
    task: cleanTask(a),
    kind,
    asked: cleanMessage(a.prompt, 200),
    last: cleanMessage(a.lastAssistantMessage, 500),
  };
}

/** Phrase faite par le code (sans LLM). */
export function plainSentence(f: Facts): string {
  if (f.label && f.outcome) {
    const states = f.lang === "en"
      ? { success: "reports success", failure: "reports a failure", interruption: "was interrupted", unconfirmed: "has an unconfirmed result", unknown: "has an unknown result" }
      : { success: "déclare une réussite", failure: "signale un échec", interruption: "a été interrompu", unconfirmed: "a un résultat non confirmé", unknown: "a un résultat inconnu" };
    return f.lang === "en"
      ? `On ${f.project}, ${f.label} ${f.kind === "en_attente" ? "is waiting for your answer" : states[f.outcome]}.`
      : `Sur ${f.project}, ${f.label} ${f.kind === "en_attente" ? "attend ta réponse" : states[f.outcome]}.`;
  }
  if (f.lang === "en") {
    const on = f.task ? `: ${f.task}` : "";
    if (f.kind === "en_attente") return `On ${f.project}, your agent is waiting for your answer${on}.`;
    if (f.kind === "interrompu") return `On ${f.project}, your agent was interrupted${on}.`;
    return `On ${f.project}, your agent is done${on}.`;
  }
  const about = f.task ? ` : ${lowerFirst(f.task)}` : "";
  if (f.kind === "en_attente") return `Sur ${f.project}, ton agent attend ta réponse${about}.`;
  if (f.kind === "interrompu") return `Sur ${f.project}, ton agent a été interrompu${about}.`;
  return `Sur ${f.project}, ton agent a fini${about}.`;
}

function lowerFirst(s: string): string {
  return s && /^[A-ZÀ-Ý][a-zà-ÿ]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

const STATE_FR: Record<Kind, string> = {
  en_cours: "travaille encore", termines: "a terminé", en_attente: "attend une réponse de l'utilisateur", interrompu: "a été interrompu",
};

const STATE_EN: Record<Kind, string> = {
  en_cours: "is still working", termines: "has finished", en_attente: "is waiting for an answer from the user", interrompu: "was interrupted",
};

export function llmPrompt(f: Facts): string {
  if (f.lang === "en") {
    return [
      "You are Floppy, a voice assistant. Tell the user, in ONE short sentence (20 words at most), in natural spoken English, that one of their code agents changed state.",
      "Rules: no branch name, hash, path, identifier or needless technical word; no markdown; say the project and the gist of the result; if the agent is waiting, say what for. Make nothing up: only say what is written in the information below.",
      `Project: ${f.project}`,
      f.label ? `Agent name to preserve: ${f.label}` : "",
      f.outcome ? `Observed outcome: ${f.outcome}. Finished does not mean successful or committed. Do not turn an unknown outcome into success.` : "",
      f.task ? `Topic: ${f.task}` : "",
      `State: the agent ${STATE_EN[f.kind]}${f.kind === "termines" ? " (it is not waiting for the user)" : ""}`,
      f.asked ? `Last request from the user: ${f.asked}` : "",
      f.last ? `Last message from the agent: ${f.last}` : "",
      "Answer with the sentence only.",
    ].filter(Boolean).join("\n");
  }
  return [
    "Tu es Floppy, un assistant vocal. Annonce à l'utilisateur, en UNE phrase courte (20 mots au plus), en français parlé et naturel, qu'un de ses agents de code a changé d'état.",
    "Règles : pas de nom de branche, de hash, de chemin, d'identifiant ni de mot technique inutile ; pas de markdown ; ne recopie pas l'anglais, résume-le en français ; dis le projet et l'essentiel du résultat ; si l'agent attend, dis ce qu'il attend. N'invente rien : dis seulement ce qui est écrit dans les informations ci-dessous.",
    `Projet : ${f.project}`,
    f.label ? `Nom individuel à conserver : ${f.label}` : "",
    f.outcome ? `Résultat observé : ${f.outcome}. Une fin ne prouve ni réussite ni commit. Ne transforme pas un résultat inconnu en succès.` : "",
    f.task ? `Sujet : ${f.task}` : "",
    `État : l'agent ${STATE_FR[f.kind]}${f.kind === "termines" ? " (il n'attend rien de l'utilisateur)" : ""}`,
    f.asked ? `Dernière demande de l'utilisateur : ${f.asked}` : "",
    f.last ? `Dernier message de l'agent : ${f.last}` : "",
    "Réponds seulement par la phrase.",
  ].filter(Boolean).join("\n");
}

export interface LlmLike { baseURL: string; model: string }

/** Demande la phrase au LLM local. Undefined si indisponible, trop lent ou réponse bizarre. */
export async function llmSentence(llm: LlmLike | undefined, f: Facts, timeoutMs = 4000, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (!llm) return undefined;
  try {
    const r = await fetchImpl(`${llm.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llm.model, temperature: 0.3, max_tokens: 80, stream: false,
        messages: [{ role: "user", content: llmPrompt(f) }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return undefined;
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    let s = (j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\[[a-zé]+\]/gi, "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
    s = s.replace(/^["«\s]+|["»\s]+$/g, "");
    if (s.length < 8 || s.length > 220) return undefined;
    return s;
  } catch {
    return undefined;
  }
}
