# Plugin Floppy « __ID__ » : règles pour un agent de code

Ce dossier est un plugin tiers pour Floppy. Il tourne dans un processus isolé : respecte ces règles,
sinon `floppy plugin check .` le refuse.

- `index.ts` fait `export default` d'un objet `{ manifest, config?, apply(ctx, config) }`. Types : `floppy-plugin.d.ts`.
- `floppy-plugin.json` et `manifest` (dans le code) ont le même `id`, la même `version` et les mêmes `permissions`.
- Aucun import à l'exécution, sauf les fichiers `.ts` de ce dossier. Pour les types : `import type { … } from "./floppy-plugin.d.ts"`.
- Pas de modules Node (`node:fs`, `child_process`…), pas de `require`, pas de `import()`, pas d'`eval`, pas de `Function`.
- Réseau : `fetch` seulement, vers les hôtes listés dans `permissions.net` (dans les deux manifestes).
- Pas d'accès aux fichiers ni aux programmes : le processus du plugin n'en a pas le droit.
- Clés des réglages : `__KEY___…`. Noms d'outils en snake_case.
- Niveau des outils : `read` (lit), `write` (change quelque chose), `send` (envoie dehors), `delete` (supprime). Dans le doute, monte d'un niveau.
- Deux langues : tout texte montré à l'utilisateur est `{ fr: "…", en: "…" }` (libellés, descriptions de réglages, `text` des résultats).
  La `description` d'un outil est lue par le modèle seulement : le français suffit.
- Tout ce qui démarre s'arrête : `ctx.interval`, `ctx.timeout`, `ctx.effect`. Pas d'état global hors de `apply`.
- Aucun secret dans le code.

Vérifier : `floppy plugin check .` puis `floppy plugin test .`. Essayer en vrai : `floppy dev .`.
