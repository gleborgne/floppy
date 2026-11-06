// `floppy plugin new <id>` : un dossier de plugin prêt à lancer, depuis le gabarit du SDK (@floppy/sdk/template).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { T, TextError } from "@floppy/core";
import { ID_RE } from "./format.ts";

export const SDK_DIR = dirname(fileURLToPath(import.meta.resolve("@floppy/sdk/package.json")));
export const TEMPLATE_DIR = join(SDK_DIR, "template");
export const SDK_TYPES = join(SDK_DIR, "floppy-plugin.d.ts");

/** Crée <parent>/<id>. Rend le dossier créé. Refuse un dossier qui existe déjà et n'est pas vide. */
export function newPlugin(id: string, parent = "."): string {
  if (!ID_RE.test(id)) throw new TextError(T("id : minuscules, chiffres et tirets, commence par une lettre (ex. « meteo-locale »)", "id: lowercase letters, digits and dashes, starting with a letter (e.g. \"local-weather\")"));
  const dir = resolve(parent, id);
  if (existsSync(dir) && readdirSync(dir).length) throw new TextError(T(`le dossier ${dir} existe déjà et n'est pas vide`, `the folder ${dir} already exists and is not empty`));
  mkdirSync(dir, { recursive: true });
  const key = id.replaceAll("-", "_");
  for (const name of readdirSync(TEMPLATE_DIR)) {
    const text = readFileSync(join(TEMPLATE_DIR, name), "utf8").replaceAll("__ID__", id).replaceAll("__KEY__", key);
    // npm ne publie pas un fichier nommé .gitignore : le gabarit le garde sans point.
    writeFileSync(join(dir, name === "gitignore" ? ".gitignore" : name), text, "utf8");
  }
  copyFileSync(SDK_TYPES, join(dir, "floppy-plugin.d.ts"));
  return dir;
}
