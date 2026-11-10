// Les étapes de migration du répertoire de travail (le moteur est dans @floppy/core : `runHomeMigrations`).
// Une étape par changement de nom d'un identifiant que Floppy a déjà écrit chez l'utilisateur : elle convertit le
// fichier une fois, le code ne lit ensuite que les nouveaux noms (pas de « les deux noms pour toujours »).
// Ajouter une étape : une entrée de plus (version suivante), idempotente, qui rapporte des noms de clés (jamais des valeurs).
// Non migrés, par choix : l'audit (`audit.jsonl`) est un journal, les nouveaux enregistrements portent les nouveaux noms.
import { runHomeMigrations, type MigrationOptions, type MigrationReport, type MigrationStep } from "@floppy/core";

/** Étape 1. Documents (`<home>/documents/*.md`) : la clé `titre:` de l'en-tête devient `title:`. */
const documentTitle: MigrationStep = {
  id: "documents-title",
  version: 1,
  label: "documents : la clé d'en-tête « titre » devient « title »",
  run(env) {
    for (const file of env.list("documents", ".md")) {
      env.editText(file, (text) => {
        const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
        if (!m) return undefined;
        const head = m[2]!;
        if (!/^titre[ \t]*:/m.test(head)) return undefined;
        if (/^title[ \t]*:/m.test(head)) { env.skip(file, "conflict"); return undefined; }
        const next = head.replace(/^titre([ \t]*:)/m, "title$1");
        return { text: m[1] + next + text.slice(m[1]!.length + head.length), keys: ["titre"] };
      });
    }
  },
};

/** Valeurs de niveau du premier lancement : français → anglais. */
const LEVELS: Record<string, string> = { texte: "text", voix: "voice", hybride: "hybrid" };

/** Étape 2. Premier lancement (`<home>/onboarding.json`) : les valeurs de `level` passent en anglais. */
const onboardingLevel: MigrationStep = {
  id: "onboarding-level",
  version: 2,
  label: "premier lancement : les niveaux « texte / voix / hybride » deviennent « text / voice / hybrid »",
  run(env) {
    env.editJson("onboarding.json", (data) => {
      const level = data.level;
      if (typeof level !== "string" || !Object.hasOwn(LEVELS, level)) return [];
      data.level = LEVELS[level];
      return ["level"];
    });
  },
};

/** Toutes les étapes, dans l'ordre. */
export const HOME_MIGRATIONS: readonly MigrationStep[] = [documentTitle, onboardingLevel];

/** Passe les étapes en attente sur ce répertoire de travail (au démarrage, ou `floppy migrate`). Ne lève jamais. */
export function migrateHome(home: string, opts: MigrationOptions = {}): MigrationReport[] {
  return runHomeMigrations(home, HOME_MIGRATIONS, opts);
}
