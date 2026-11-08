// Liste des plugins connus. Une entrée de la config choisit un plugin par son id (champ `plugin:`).
// Chaque paquet est chargé à part (import dynamique) : un plugin qui plante au chargement de son module ne
// bloque plus le démarrage. Ses entrées passent en erreur visible, et le reste démarre.
import type { PluginDef } from "@floppy/core";

/** Paquets des plugins livrés, dans l'ordre (le premier fournisseur actif d'un service gagne, à défaut de choix). */
export const PACKAGES: readonly string[] = [
  "@floppy/plugin-tools",
  "@floppy/plugin-llm-llamacpp",
  "@floppy/plugin-llm-openai",
  "@floppy/plugin-memory",
  "@floppy/plugin-voice-vocabulary",
  "@floppy/plugin-brain-aisdk",
  "@floppy/plugin-brain-claude-cli",
  "@floppy/plugin-brain-codex-cli",
  "@floppy/plugin-brain-agy-cli",
  "@floppy/plugin-agent-opencode",
  "@floppy/plugin-agent-pi",
  "@floppy/plugin-agent-omp",
  "@floppy/plugin-agent-hermes",
  "@floppy/plugin-agent-copilot",
  "@floppy/plugin-agent-cursor",
  "@floppy/plugin-agent-aider",
  "@floppy/plugin-body-hub",
  "@floppy/plugin-body-ws",
  "@floppy/plugin-body-electron",
  "@floppy/plugin-display-agent-tracking",
  "@floppy/plugin-body-reachy",
  "@floppy/plugin-conversation",
  "@floppy/plugin-orca",
  "@floppy/plugin-browser",
  "@floppy/plugin-inbox",
  "@floppy/plugin-websearch",
  "@floppy/plugin-m365",
  "@floppy/plugin-avatar-tv",
  "@floppy/plugin-avatar-pixel",
  "@floppy/plugin-avatar-essaim",
  "@floppy/plugin-avatar-gyre",
  "@floppy/plugin-avatar-goutte",
  "@floppy/plugin-avatar-oscillo",
  "@floppy/plugin-avatar-iris",
  "@floppy/plugin-avatar-pixelcat",
  "@floppy/plugin-coder",
  "@floppy/plugin-agent-sessions",
  "@floppy/plugin-agent-jobs",
  "@floppy/plugin-tts-gemini",
  "@floppy/plugin-tts-elevenlabs",
  "@floppy/plugin-live-gemini",
  "@floppy/plugin-live-openai",
  "@floppy/plugin-wakeword-stt",
  "@floppy/plugin-wakeword-sherpa",
  "@floppy/plugin-wakeword-porcupine",
  "@floppy/plugin-searxng",
  "@floppy/plugin-documents",
  "@floppy/plugin-scheduler",
  "@floppy/plugin-veille",
  "@floppy/plugin-notify-telegram",
  "@floppy/plugin-notify-mail",
  "@floppy/plugin-tts-audiocpp",
  "@floppy/plugin-tts-system",
  "@floppy/plugin-voice-listen",
  "@floppy/plugin-stt-sherpa",
];

/**
 * Plugins de développement, chargés seulement avec FLOPPY_DEV=1. `bench-api` répond aux accords tout seul pour le banc
 * (en-tête X-Approval) : il ne doit jamais tourner dans un Floppy de tous les jours.
 */
export const DEV_PACKAGES: readonly string[] = ["@floppy/plugin-bench-api"];

export interface LoadedCatalog {
  plugins: PluginDef<any>[];
  /** Paquets qui n'ont pas pu se charger, avec la raison. */
  failed: { pkg: string; error: string }[];
}

/** Charge les plugins livrés (et ceux de développement si `dev`). Un paquet qui échoue est rendu dans `failed`. */
export async function loadCatalog(opts: { dev?: boolean; packages?: readonly string[] } = {}): Promise<LoadedCatalog> {
  const list = opts.packages ?? [...PACKAGES, ...((opts.dev ?? process.env.FLOPPY_DEV === "1") ? DEV_PACKAGES : [])];
  const results = await Promise.allSettled(list.map((pkg) => import(pkg) as Promise<{ default?: PluginDef<any> }>));
  const plugins: PluginDef<any>[] = [];
  const failed: LoadedCatalog["failed"] = [];
  results.forEach((r, i) => {
    const pkg = list[i]!;
    if (r.status === "rejected") failed.push({ pkg, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    else if (!r.value.default?.manifest) failed.push({ pkg, error: "pas de plugin exporté par défaut (definePlugin)" });
    else plugins.push(r.value.default);
  });
  return { plugins, failed };
}
