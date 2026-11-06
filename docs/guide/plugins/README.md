# Écrire un plugin Floppy

*English: [README.en.md](README.en.md)*

Ce guide explique comment écrire un plugin, l'essayer, puis le donner à d'autres.
Un plugin ajoute une capacité à Floppy : des outils que l'assistant peut appeler, et des réglages.

- Les types sont dans [`packages/sdk/floppy-plugin.d.ts`](../../../packages/sdk/floppy-plugin.d.ts). Ce fichier sert de référence complète.
- Il y a deux exemples dans [`packages/sdk/examples`](../../../packages/sdk/examples) : un minuteur, et une météo qui utilise le réseau.
- Pour savoir comment Floppy contrôle et isole un plugin, voir la spec [Plugins tiers](../../spec/plugins-tiers.md).

## Démarrer en 5 minutes

```sh
floppy plugin new mon-plugin          # crée le dossier mon-plugin/ depuis le gabarit
floppy dev mon-plugin                 # lance Floppy avec ce plugin
```

Dans un autre terminal :

```sh
floppy tool mon_plugin_bonjour '{"nom":"Ada"}' --home mon-plugin/.floppy-dev
floppy chat --home mon-plugin/.floppy-dev     # parler à Floppy au clavier
```

Modifie `mon-plugin/index.ts` et enregistre. Le plugin redémarre tout seul.

> `floppy` est la CLI du dépôt (`apps/cli/src/main.ts`). Depuis le dépôt, `node apps/cli/src/main.ts <commande>` fait la même chose.

## Ce qu'est un plugin

Un plugin est un dossier. Il contient au moins deux fichiers.

| Fichier | Rôle |
|---|---|
| `floppy-plugin.json` | La carte d'identité : id, version, licence, droits. Floppy la lit **sans exécuter de code**. |
| `index.ts` | Le code. Il fait `export default` d'un objet `{ manifest, config?, apply(ctx, config) }`. |
| `floppy-plugin.d.ts` | Les types. Le code les importe avec `import type`, effacé à l'exécution. |
| `AGENTS.md`, `CLAUDE.md` | Les règles pour un agent de code (Claude Code, Codex) qui t'aide à écrire le plugin. |

`apply(ctx, config)` s'exécute quand le plugin démarre. Il y enregistre ses outils et ses réglages.

## La carte d'identité

```json
{
  "id": "meteo",
  "version": "1.0.0",
  "licence": "MIT",
  "api": 1,
  "description": { "fr": "La météo du moment.", "en": "The current weather." },
  "permissions": { "net": ["api.open-meteo.com"], "cloud": true }
}
```

- `id` : minuscules, chiffres et tirets. Il commence par une lettre. C'est aussi le nom du dossier une fois installé.
- `api` : la version de l'API des plugins. Aujourd'hui `1`.
- `permissions.net` : les hôtes que le plugin peut joindre. Sans cette liste, il n'a aucun accès réseau. `*.contoso.com` couvre les sous-domaines.
- `permissions.cloud` : le plugin envoie des données de l'utilisateur à un service en ligne.
- Le `manifest` du code a **les mêmes** `id`, `version` et `permissions`. Floppy compare les deux et refuse un écart.

## Ce que `ctx` permet

| Appel | Pour quoi |
|---|---|
| `ctx.tools.register([...])` | Ajouter des outils. |
| `ctx.settings.declare([...])`, `ctx.settings.saved(clé)` | Ajouter des réglages ; relire une valeur gardée. |
| `ctx.emit("initiative", {...})` | Dire quelque chose à l'utilisateur de soi-même (fin d'un minuteur). |
| `ctx.on("service.changed", fn)` | Écouter un événement. |
| `ctx.interval`, `ctx.timeout`, `ctx.effect` | Minuteurs et nettoyage, arrêtés tout seuls quand le plugin s'arrête. |
| `ctx.log(niveau, message)`, `ctx.audit.write({...})` | Journal. Jamais de secret dedans. |
| `ctx.alive`, `ctx.fail(raison)` | Savoir si le plugin tourne encore ; signaler une panne grave. |
| `fetch(url)` | Réseau, seulement vers les hôtes de `permissions.net`. |

## Les outils

Chaque outil a un nom, une description, un schéma JSON de ses paramètres, un **niveau** et une fonction `handler`.

| Niveau | Quand | Accord de l'utilisateur |
|---|---|---|
| `read` | L'outil lit seulement. | Non |
| `write` | Il crée ou change quelque chose chez l'utilisateur. | Oui, par défaut |
| `send` | Il envoie quelque chose dehors (message, requête qui publie, donnée à un service). | Oui, par défaut |
| `delete` | Il supprime. | Oui |

- Choisis le niveau le plus prudent qui convient. Dans le doute, monte d'un niveau.
- Le plugin ne demande jamais l'accord lui-même : c'est Floppy qui le fait, avant d'appeler `handler`.
- Les arguments viennent d'un modèle de langage. Vérifie-les : type, longueur, bornes.
- `description` est lue par le modèle seulement. Le français suffit.

## Les réglages

Un réglage apparaît dans la fenêtre des réglages et se change aussi à la voix.

- La clé commence par l'id du plugin, tirets remplacés par `_`. Exemple : `meteo_unite` pour le plugin `meteo`.
- `type` : `enum`, `number`, `boolean` ou `text`.
- `risk` : `free` (appliqué tout de suite), `ask` (accord demandé), `cli` (jamais à la voix : clic ou CLI). Prends `cli` pour tout ce qui touche aux droits.
- `set(valeur)` vérifie la valeur avant de l'appliquer.
- La fenêtre des réglages est construite à partir de ces déclarations. Un plugin ne fournit pas d'interface à lui.

## Deux langues

Tout texte qu'une personne lit existe en français et en anglais : `{ fr: "…", en: "…" }`.

Cela vaut pour les libellés, les descriptions de réglages, les options et le `text` rendu par un outil. Floppy choisit la langue. Les mots dits à l'oral (`aliases`) sont acceptés dans les deux langues.

## Ce qui est interdit, et pourquoi

Un plugin tiers tourne dans un **processus à part**, fermé par le modèle de permissions de Node. Floppy vérifie aussi le code avant l'installation (`floppy plugin check`).

| Interdit | Pourquoi |
|---|---|
| `import` d'un module (Node, npm) ; `require` ; `import()` | Le plugin ne doit rien charger que la revue n'a pas lu. Les fichiers `.ts` du plugin lui-même restent permis. |
| Fichiers, programmes, modules natifs | Le processus du plugin n'en a pas le droit. |
| `eval`, `Function`, WebAssembly | Du code construit à l'exécution échappe à la revue. |
| `fetch` sans `permissions.net`, WebSocket | Le réseau passe par Floppy, qui vérifie chaque hôte, redirections comprises. |
| Code minifié, caractères invisibles, `.js` | Ce que l'on relit doit être ce qui tourne. |
| `package.json` avec dépendances ou scripts | Aucun paquet npm, aucun script d'installation. |

Le processus n'a pas de variables d'environnement. Il ne voit donc aucune clé ni aucun jeton.

## Le mode debug

```sh
floppy dev <dossier> [--inspect] [--home <dossier>] [--config floppy.yml]
```

- Le plugin est lu là où tu le codes. Il est activé d'office.
- Chaque sauvegarde le redémarre. Ses outils et ses réglages sont mis à jour.
- Les données vont dans `<dossier>/.floppy-dev` : ta vraie config et tes vrais réglages ne bougent pas. `--home` choisit un autre dossier.
- La config utilisée est `--config`, sinon `./floppy.yml`, sinon celle du dépôt de Floppy, sinon une config vide. Avec la config du dépôt, ton cerveau habituel répond dans `floppy chat`.
- `floppy tool <outil> '<json>'` appelle un outil sans passer par le modèle. Si l'outil demande un accord, la question s'affiche dans le terminal.
- `--inspect` ouvre le débogueur de Node sur le processus du plugin (port 9229). Dans VS Code, ajoute une configuration « attach » :

  ```json
  { "type": "node", "request": "attach", "name": "Plugin Floppy", "port": 9229 }
  ```

  Node ne permet pas d'ouvrir le débogueur et d'appliquer les permissions en même temps. Avec `--inspect`, l'isolation des fichiers est donc levée. N'utilise ce mode que sur ton propre code.
- Avec l'app de bureau : `npm start -- --dev-plugin <dossier>` (répétable).

## Vérifier avant de publier

```sh
floppy plugin check <dossier>    # les contrôles faits chez la personne qui installe
floppy plugin test <dossier>     # démarre le plugin 10 s dans un noyau jetable : état, outils, réglages, journal
```

## Publier et installer

Publie le dossier comme un dépôt git, ou comme une archive `.zip`. La personne qui installe tape :

```sh
floppy plugin install https://contoso.example/meteo.git#v1.0.0
floppy plugin install C:/Downloads/meteo.zip
```

Elle peut aussi demander à Floppy : « installe le plugin https://… ».

Ensuite, Floppy fait ceci :

1. Il copie le plugin dans une quarantaine. Rien n'est exécuté.
2. Il lance les contrôles automatiques.
3. Un agent de code relit le code : Claude Code, Codex ou Antigravity. **Sans agent installé, l'installation est refusée.** Le choix de l'agent est le réglage « Relecteur des plugins tiers ».
4. La fenêtre des réglages montre le rapport, rubrique Plugins : « Installer « meteo » ». Un clic installe le plugin. Ce clic n'est jamais possible à la voix.
5. Le plugin installé reste éteint. Un second clic l'active.

Floppy garde l'empreinte du contenu relu. Si un fichier change après l'installation, le plugin ne démarre plus. Il faut le réinstaller, et il est relu à nouveau.

Autres commandes : `floppy plugin list`, `floppy plugin approve <id>`, `floppy plugin remove <id>`.

## Plugin personnel ou plugin tiers

| | Plugin personnel | Plugin tiers |
|---|---|---|
| Où | `<dossier de Floppy>/plugins/<id>/index.ts` | Installé par `floppy plugin install` |
| Écrit par | Toi, ou l'assistant IA de la fenêtre des réglages | Quelqu'un d'autre |
| `floppy-plugin.json` | Non | Oui |
| Exécution | Dans le noyau, avec tous ses droits | Dans un processus isolé |
| Revue par une IA | Non | Oui, obligatoire |

Un dossier qui a un `floppy-plugin.json` tourne toujours isolé, même copié à la main.
