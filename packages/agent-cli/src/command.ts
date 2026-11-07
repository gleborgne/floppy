// Les shims npm ne sont pas exécutables par CreateProcess : on lance leur script Node sans passer par un shell.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findExe, T, TextError } from "@floppy/core";

export function agentCommand(exe: string, args: string[]): { command: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(exe)) return { command: exe, args };
  const shim = readFileSync(exe, "utf8");
  const target = /"%dp0%[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"\s+%\*/i.exec(shim)?.[1];
  if (!target || !/"%_prog%"/i.test(shim)) throw new TextError(T("Ce lanceur n'est pas pris en charge. Indique le programme natif.", "This launcher is unsupported. Set the native program path."));
  const script = resolve(dirname(exe), target);
  if (!existsSync(script)) throw new TextError(T("Le script de l'agent est introuvable.", "The agent script was not found."));
  return { command: findExe("node") ?? process.execPath, args: [script, ...args] };
}
