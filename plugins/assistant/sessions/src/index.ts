// Plugin `agent-sessions` : ouvrir une VRAIE session Claude Code, Codex ou Antigravity dans un terminal, sur une consigne.
// « Floppy, demande à Claude d'utiliser Opus pour analyser les bugs des 3 derniers mois et me faire un artefact. »
//
// - La session est celle du CLI de l'utilisateur, avec SES droits, SES serveurs MCP et SES connecteurs : c'est le CLI
//   qui demande ses autorisations, dans le terminal, à l'utilisateur. Floppy ne bride rien ici (≠ cerveau et délégation).
// - L'ouverture passe par l'accord du noyau (niveau write) : le résumé dit quel agent, quel modèle, quel dossier.
// - Sécurité : la consigne est écrite dans un fichier (<home>/sessions/<horodatage>.md). Le terminal reçoit seulement
//   une phrase fixe qui désigne ce fichier : ce que l'utilisateur dit ne devient jamais une ligne de commande.
//   Le nom du modèle est vérifié (lettres, chiffres, . _ : -). Le dossier donné doit exister.
// - Le terminal est lancé détaché, sans shell quand c'est possible : il reste ouvert si Floppy s'arrête.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { definePlugin, findExe, type Context, type Text } from "@floppy/core";

const t = (fr: string, en: string): Text => ({ fr, en });

export const Config = z.object({
  /** Dossier où chaque session sans dossier précis reçoit son propre sous-dossier. Défaut : l'espace de travail du plugin. */
  dossier: z.string().optional(),
  /** Programmes (défaut : cherchés dans le PATH). */
  claudeExe: z.string().optional(),
  codexExe: z.string().optional(),
  agyExe: z.string().optional(),
});
type Config = z.infer<typeof Config>;

export type Agent = "claude" | "codex" | "antigravity";
const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };

/** Lance `cmd args` dans un nouveau terminal, dans `dir`. Injecté dans les tests. */
export type Launcher = (dir: string, title: string, cmd: string, args: string[], spawn: Context["spawn"]) => Promise<void>;

/** Citation pour un shell POSIX (macOS, Linux) : tout entre apostrophes. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Le terminal s'ouvre par ctx.spawn (gardé ouvert après Floppy, programme permis par le manifeste). */
export const defaultLauncher: Launcher = (dir, title, cmd, args, spawn) => new Promise((ok, ko) => {
  let p;
  if (process.platform === "win32") {
    const wt = findExe("wt");
    // Windows Terminal : -d dossier, puis la commande (wt découpe sur « ; » : la phrase fixe n'en contient pas).
    p = wt
      ? spawn(wt, ["-w", "new", "-d", dir, "--title", title, cmd, ...args], { keep: true, windowsHide: false })
      : spawn("cmd.exe", ["/c", "start", title, "/D", dir, cmd, ...args], { keep: true, windowsHide: true });
  } else if (process.platform === "darwin") {
    const line = `cd ${sh(dir)} && ${[cmd, ...args].map(sh).join(" ")}`;
    p = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(line)}`, "-e", 'tell application "Terminal" to activate'], { keep: true });
  } else {
    p = spawn("x-terminal-emulator", ["-e", cmd, ...args], { cwd: dir, keep: true });
  }
  p.once("error", ko);
  p.once("spawn", () => { p.unref(); ok(); });
});

/** Nom de dossier lisible : « 2026-11-06-1830-analyser-les-bugs ». */
export function sessionFolderName(consigne: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = consigne.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
  return slug ? `${stamp}-${slug}` : stamp;
}

/** La phrase fixe donnée au CLI : elle désigne le fichier de la consigne (jamais le texte dicté lui-même). */
export function startPrompt(file: string, lang: string): string {
  return lang === "en"
    ? `Read the file ${file} and do what it asks. When you produce an artifact or a document, give its link or path at the end.`
    : `Lis le fichier ${file} et fais ce qui est demandé. Quand tu produis un artefact ou un document, donne son lien ou son chemin à la fin.`;
}

/** Arguments du CLI : session interactive, modèle choisi, consigne de départ. */
export function cliArgs(agent: Agent, model: string | undefined, prompt: string): string[] {
  const m = model ? (agent === "codex" ? ["-m", model] : ["--model", model]) : [];
  return agent === "antigravity" ? [...m, "-i", prompt] : [...m, prompt];
}

export function createSessionsPlugin(launcher: Launcher = defaultLauncher) {
  return definePlugin<Config>({
    manifest: {
      id: "agent-sessions",
      version: "0.1.0",
      licence: "MIT",
      description: "Ouvre une session Claude Code, Codex ou Antigravity dans un terminal, sur une consigne dictée.",
      permissions: { exec: ["wt", "cmd", "osascript", "x-terminal-emulator"], "fs.write": ["workspaces/sessions"] },
      addable: {
        section: "cerveau",
        label: t("Sessions d'agent", "Agent sessions"),
        description: t("« Demande à Claude d'utiliser Opus pour… » : ouvre une vraie session Claude Code, Codex ou Antigravity dans un terminal, avec ses propres droits.",
          "\"Ask Claude to use Opus to…\": opens a real Claude Code, Codex or Antigravity session in a terminal, with its own permissions."),
        single: true,
        aliases: ["sessions", "claude code", "codex", "antigravity", "terminal"],
        fields: [{
          key: "dossier", label: t("Dossier des sessions", "Sessions folder"), type: "path", directory: true,
          hint: t("Chaque session sans dossier précis y reçoit son sous-dossier.", "Each session without a given folder gets its own subfolder here."),
        }],
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const exeOf = (a: Agent) => a === "claude" ? cfg.claudeExe ?? findExe("claude")
        : a === "codex" ? cfg.codexExe ?? findExe("codex") : cfg.agyExe ?? findExe("agy");
      const installed = (["claude", "codex", "antigravity"] as Agent[]).filter((a) => exeOf(a));
      ctx.items.status(installed.length
        ? t(`prêt : ${installed.map((a) => NAMES[a]).join(", ")}`, `ready: ${installed.map((a) => NAMES[a]).join(", ")}`)
        : t("aucun CLI trouvé (claude, codex, agy)", "no CLI found (claude, codex, agy)"), installed.length ? "ok" : "warn");
      const label = (a: Record<string, unknown>) => {
        const agent = NAMES[a.agent as Agent] ?? String(a.agent);
        const model = a.modele ? ` (${String(a.modele)})` : "";
        return { agent: `${agent}${model}`, dir: a.dossier ? String(a.dossier) : "" };
      };
      ctx.tools.register([{
        name: "ouvrir_session_agent",
        description: "Ouvre une vraie session d'agent (Claude Code, Codex ou Antigravity) dans un terminal de l'utilisateur, sur une consigne. "
          + "Utilise-le quand l'utilisateur demande à Claude, Codex ou Antigravity de faire un travail long ou outillé (analyser, produire un artefact, un document, une présentation, du code). "
          + "La session a les droits et les connecteurs propres du CLI ; l'utilisateur la suit dans le terminal. Réécris la demande en une consigne complète et autonome.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", enum: ["claude", "codex", "antigravity"], description: "Le CLI demandé." },
            consigne: { type: "string", description: "La tâche complète, en phrases (contexte, attendu, format du résultat)." },
            modele: { type: "string", description: "Modèle demandé, s'il est dit. Claude : opus, sonnet ou haiku. Codex : ex. gpt-6.1-sol. Antigravity : ex. gemini-4-argon-medium. Sinon, ne rien mettre." },
            dossier: { type: "string", description: "Dossier de travail absolu, seulement si l'utilisateur en nomme un. Sinon, ne rien mettre : un dossier neuf est créé." },
          },
          required: ["agent", "consigne"],
        },
        level: "write",
        summary: (a) => {
          const l = label(a);
          return l.dir
            ? t(`Ouvrir ${l.agent} dans ${l.dir} ?`, `Open ${l.agent} in ${l.dir}?`)
            : t(`Ouvrir ${l.agent} dans un nouveau dossier ?`, `Open ${l.agent} in a new folder?`);
        },
        handler: async (a) => {
          const agent = String(a.agent ?? "") as Agent;
          if (!NAMES[agent]) return { status: "failed", text: `Agent inconnu : ${String(a.agent)}. Choix : claude, codex, antigravity.` };
          const consigne = String(a.consigne ?? "").trim();
          if (!consigne) return { status: "failed", text: "Il manque la consigne." };
          const model = a.modele ? String(a.modele).trim().toLowerCase().replace(/\s+/g, "-") : undefined;
          if (model && !/^[a-z0-9._:-]{1,60}$/.test(model)) return { status: "failed", text: `Nom de modèle refusé : ${String(a.modele)}.` };
          const exe = exeOf(agent);
          if (!exe) return { status: "failed", text: `${NAMES[agent]} n'est pas installé sur cet ordinateur (programme introuvable).` };
          let dir: string;
          if (a.dossier) {
            dir = String(a.dossier);
            if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return { status: "failed", text: `Dossier introuvable : ${dir}.` };
          } else {
            dir = join(cfg.dossier ?? ctx.workspace(), sessionFolderName(consigne));
            mkdirSync(dir, { recursive: true });
          }
          // La consigne vit dans un fichier, hors du dossier de travail (on ne salit pas un dépôt de l'utilisateur).
          const notes = join(ctx.home, "sessions");
          mkdirSync(notes, { recursive: true });
          const file = join(notes, `${sessionFolderName("")}-${agent}.md`);
          writeFileSync(file, `${consigne}\n`, "utf8");
          const prompt = startPrompt(file, ctx.assistant.language);
          try {
            await launcher(dir, `Floppy · ${NAMES[agent]}`, exe, cliArgs(agent, model, prompt), ctx.spawn);
          } catch (e) {
            return { status: "failed", text: `Le terminal ne s'est pas ouvert : ${e instanceof Error ? e.message : String(e)}` };
          }
          ctx.audit.write({ kind: "agent.session", agent, model: model ?? null, dir });
          return { status: "done", text: `Session ${NAMES[agent]}${model ? ` (${model})` : ""} ouverte dans un terminal, dossier ${dir}. L'utilisateur la suit et répond dans le terminal ; le résultat (lien d'artefact, fichier) y apparaîtra.` };
        },
      }]);
    },
  });
}

export default createSessionsPlugin();
