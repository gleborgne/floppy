// Lecture de floppy.yml et rechargement à chaud.
import { readFileSync, watch, existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse } from "yaml";
import { KernelConfig } from "./schema.ts";
import type { Kernel } from "../plugin/kernel.ts";
import { T, TextError } from "../i18n.ts";

export function loadConfigFile(path: string): KernelConfig {
  if (!existsSync(path)) throw new TextError(T(`config introuvable : ${path}`, `config not found: ${path}`));
  const raw: unknown = parse(readFileSync(path, "utf8")) ?? {};
  const r = KernelConfig.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("\n  ");
    throw new TextError(T(`config invalide (${path}) :\n  ${issues}`, `invalid config (${path}):\n  ${issues}`));
  }
  return r.data;
}

/**
 * Surveille le fichier et applique chaque nouvelle version valide.
 * Une version invalide est signalée et ignorée : l'ancienne config reste active.
 */
export function watchConfig(path: string, kernel: Kernel, onError: (e: Error) => void = (e) => console.error(e.message)): () => void {
  let timer: NodeJS.Timeout | undefined;
  let last = readFileSync(path, "utf8");
  // On surveille le dossier (filtré sur le nom du fichier) : un enregistrement par renommage remplace le fichier,
  // et une surveillance posée sur le fichier lui-même s'arrêterait de recevoir des événements.
  const name = basename(path);
  const w = watch(dirname(path), (_ev, file) => {
    if (file && file.toString() !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { return; }
      if (text === last) return;
      last = text;
      try {
        void kernel.applyConfig(loadConfigFile(path)).catch(onError);
      } catch (e) {
        onError(e as Error);
      }
    }, 200);
  });
  return () => { clearTimeout(timer); w.close(); };
}
