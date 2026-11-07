# Écrire un plugin Floppy

> English: this starter kit is written in French. The coding agent reads it and still answers in your language; follow the same rules and the example.

Ce dossier contient tes plugins personnels. Un plugin = un dossier `<id>/index.ts`.
Exemple complet : `exemple-minuteur/index.ts`. Les types sont dans `floppy-plugin.d.ts`.
Le wiki à jour (en anglais) est l'outil MCP `doc_plugins` : appelle-le sans argument pour le sommaire, puis `{ page: "basics" }`.
Il décrit aussi les services de Floppy (envoyer un message, demander au modèle, chercher sur le web) et leurs contrats.

## Règles du format

- Dossier `<id>/` avec un fichier `index.ts`. L'id suit `^[a-z][a-z0-9-]*$` (minuscules, chiffres, tirets).
- `manifest.id` est EXACTEMENT le nom du dossier.
- `index.ts` fait `export default` d'un simple objet `{ manifest, config?, apply }`.
- AUCUN import à l'exécution : pas de `import x from "..."`, pas de `require`, pas de module npm.
  Un seul import est permis, pour les types : `import type { UserPlugin } from "../floppy-plugin.d.ts";`
- Le manifeste a au moins : `id`, `version` (ex. "0.1.0"), `licence` (ex. "MIT"), et une `description` en français.
- `provides` : services que le plugin fournit (le plus souvent rien). `inject` : services obligatoires dont il a besoin.
- `apply(ctx, config)` s'exécute au démarrage du plugin. Tout ce qu'il enregistre doit pouvoir s'arrêter.

## Ce que `ctx` permet

- `ctx.tools.register([...])` : ajoute des outils que l'assistant peut appeler.
- `ctx.settings.declare([...])` et `ctx.settings.saved(clé)` : réglages visibles dans la fenêtre des réglages.
- `ctx.on(event, fn)` / `ctx.emit(event, payload)` : événements. Utile : `initiative` (l'assistant dit quelque chose de lui-même).
- `ctx.effect(fn)` : nettoyage (arrêter un minuteur, fermer une connexion). Appelé à l'arrêt ou au rechargement.
- `ctx.interval(fn, ms)` et `ctx.timeout(fn, ms)` : minuteurs arrêtés automatiquement.
- `ctx.log(niveau, message)` et `ctx.audit.write({ kind, ... })` : journal.
- `ctx.alive` : faux quand le plugin est arrêté. Vérifie-le avant d'agir dans un rappel tardif.

## Les outils

Chaque outil a : `name` (snake_case), `description` (quand l'utiliser), `inputSchema` (JSON Schema, `type: "object"`),
`level`, `handler(args, meta)` qui rend `{ status, text }`.

Niveaux (ils décident de la demande d'accord) :
- `read` : lit seulement, sans effet. Aucun accord.
- `write` : crée ou change quelque chose chez l'utilisateur.
- `send` : envoie quelque chose à l'extérieur (mail, message, requête qui publie).
- `delete` : supprime. Toujours demandé.

Choisis le niveau le plus prudent qui convient. Dans le doute, monte d'un niveau.
Le texte rendu par le `handler` est court, en français, et dit ce qui s'est passé. Valide les `args` : ils viennent d'un modèle.

## Les réglages

Chaque réglage a `key` (préfixée par l'id du plugin, `[a-z0-9_]`), `label`, `description`, `type`
(`enum`, `number`, `boolean`, `text`), `group`, `risk`, `get()` et `set(valeur)`.
Risques :
- `free` : appliqué tout de suite, annulable.
- `ask` : l'application demande l'accord avant (par exemple pour allumer quelque chose qui sort de la machine).
- `cli` : jamais à la voix ; l'utilisateur le change lui-même dans la fenêtre. À utiliser pour tout ce qui touche aux droits.
Valide la valeur dans `set` (bornes, longueur). Une valeur gardée se relit avec `ctx.settings.saved(clé)` au démarrage.

## Effets et nettoyage

Un plugin peut être rechargé à tout moment. Tout ce que tu démarres (minuteur, écoute, connexion) doit être arrêté :
utilise `ctx.interval` / `ctx.timeout` (automatique) ou `ctx.effect(() => ...)`. Ne garde pas d'état global hors de `apply`.

## Textes

Tout ce que l'utilisateur voit ou entend existe en français et en anglais, en phrases simples : `{ fr: "…", en: "…" }`.
Cela vaut pour les libellés, les descriptions de réglages, les options et le `text` rendu par un outil. Floppy choisit la langue.
La `description` d'un outil est lue par le modèle seulement : le français suffit.
Le code (noms de variables) peut être en français ou en anglais simple.
Guide complet : docs/guide/plugins/README.md dans le dépôt de Floppy.

## Sécurité

- Aucun secret dans le code (clé API, mot de passe, jeton). Si un secret est nécessaire, dis-le à l'utilisateur : il le règle lui-même.
- Aucun accès réseau sans le déclarer dans `manifest.permissions.net` (liste d'hôtes). Même chose pour `fs.read`, `fs.write` et `exec`.
- N'écris que ce dont le plugin a besoin. Ne lance pas de programme que tu n'as pas déclaré.
- Ne lis ni ne modifie jamais les fichiers des autres plugins ou de l'application.

## Après avoir écrit ou modifié un plugin

1. Appelle l'outil MCP `tester_plugin` avec l'id du plugin. Il vérifie le format et charge le plugin à blanc.
2. Corrige les erreurs, puis rappelle `tester_plugin` jusqu'à ce qu'il soit bon.
3. Appelle `recharger_plugins` pour que Floppy relise le dossier.
4. Dis à l'utilisateur d'activer le plugin d'un clic dans la fenêtre des réglages. Tu ne peux pas l'activer toi-même.
`etat_plugins` montre l'état de chaque plugin (utile si quelque chose ne démarre pas).

## Ce que tu peux écrire ici

Seulement dans ce dossier. Chaque écriture ou modification est montrée à l'utilisateur, qui l'accepte ou la refuse.
Si c'est refusé, ne réessaie pas à l'identique : demande-lui ce qu'il veut changer.
