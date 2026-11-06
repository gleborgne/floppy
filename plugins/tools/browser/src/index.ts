// Plugin `browser` : ouvrir une adresse web dans le navigateur. C'est une « application » : l'utilisateur
// l'ajoute ou la retire dans Réglages → Connecteurs (manifest.addable).
//
// - Un seul outil : ouvrir_url. Seulement http et https (pas de file:, javascript:, etc.).
// - Par défaut, chaque ouverture demande l'accord (niveau write). L'utilisateur peut l'enlever dans le formulaire.
// - Navigateur : celui de Windows par défaut, ou un programme choisi (Edge, Chrome, Firefox…).
// - Lancé sans shell : l'adresse ne peut pas devenir une commande.
import { spawn } from "node:child_process";
import { z } from "zod";
import { definePlugin, type Text } from "@floppy/core";

const t = (fr: string, en: string): Text => ({ fr, en });

export const Config = z.object({
  /** Demander l'accord avant chaque ouverture. */
  ask: z.boolean().default(true),
  /** Programme du navigateur (vide = navigateur par défaut de Windows). */
  program: z.string().default(""),
});
type Config = z.infer<typeof Config>;

export type Opener = (url: string, program: string) => Promise<void>;

/** Ouvre sans shell. Windows : rundll32 url.dll (navigateur par défaut) ; ailleurs : open / xdg-open. */
export const defaultOpener: Opener = (url, program) => new Promise((ok, ko) => {
  const [cmd, args] = program
    ? [program, [url]]
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  p.once("error", ko);
  p.once("spawn", () => { p.unref(); ok(); });
});

export function checkUrl(raw: unknown): URL {
  const s = String(raw ?? "").trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("adresse invalide"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("seules les adresses http et https s'ouvrent");
  return u;
}

export function createBrowserPlugin(opener: Opener = defaultOpener) {
  return definePlugin<Config>({
    manifest: {
      id: "browser",
      version: "0.1.0",
      licence: "MIT",
      sections: [
        { id: "connecteurs", label: { fr: "Connecteurs", en: "Connectors" } },
      ],
      description: "Ouvre une adresse web dans le navigateur.",
      // Navigateur par défaut seulement ; un programme choisi dans le formulaire demanderait "*" (spawn brut, non contrôlé).
      permissions: { exec: ["rundll32", "open", "xdg-open"] },
      addable: {
        section: "connecteurs",
        single: true,
        label: t("Navigateur", "Web browser"),
        description: t("Floppy peut ouvrir une page web (lien, PR, ticket…) dans ton navigateur.", "Floppy can open a web page (link, PR, ticket…) in your browser."),
        aliases: ["navigateur", "browser", "ouvrir url"],
        fields: [
          { key: "ask", label: t("Demander mon accord avant d'ouvrir", "Ask me before opening"), type: "boolean", default: true },
          {
            key: "program", label: t("Navigateur", "Browser"), type: "path", filters: [{ name: "Programme / Program", extensions: ["exe"] }],
            hint: t("Vide = le navigateur par défaut du système. Sinon, choisis le programme de ton navigateur (Edge, Chrome, Firefox…).", "Empty = the system default browser. Otherwise pick your browser program (Edge, Chrome, Firefox…)."),
          },
        ],
      },
    },
    config: Config,
    apply(ctx, cfg) {
      ctx.tools.register([{
        name: "ouvrir_url",
        description: "Ouvre une adresse web (http ou https) dans le navigateur de l'utilisateur. Utilise-le dès qu'on te demande d'ouvrir une page, un lien, une PR, un ticket ou un build : ne dis jamais que tu ne peux pas ouvrir une page. Fais l'adresse web avec les informations des autres outils.",
        inputSchema: { type: "object", properties: { url: { type: "string", description: "Adresse complète, http ou https." } }, required: ["url"] },
        level: cfg.ask ? "write" : "read",
        summary: (a) => { const u = String(a.url ?? "").slice(0, 120); return t(`Ouvrir ${u} ?`, `Open ${u}?`); },
        handler: async (a) => {
          let u: URL;
          try { u = checkUrl(a.url); } catch (e) { return { status: "failed", text: `Pas ouvert : ${(e as Error).message}.` }; }
          try {
            await opener(u.href, cfg.program);
          } catch (e) {
            return { status: "failed", text: `Le navigateur ne s'est pas ouvert : ${e instanceof Error ? e.message : String(e)}` };
          }
          return { status: "done", text: `Ouvert dans le navigateur : ${u.host}.` };
        },
      }]);
      ctx.items.status(cfg.program ? t("navigateur choisi", "chosen browser") : t("navigateur par défaut", "default browser"));
    },
  });
}

export default createBrowserPlugin();
