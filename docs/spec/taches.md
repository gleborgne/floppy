# Tâches et Planificateur (implémenté)

[← Retour à la spec](README.md)

État : **fait** le 6 novembre 2026. Code : `assistant\packages\core\src\tasks.ts` (registre), `assistant\plugins\tasks\scheduler` (horloge). Premier utilisateur : la [veille](veille.md).

## L'idée : quoi, quand, qui déclenche

Une **tâche** est un travail qu'un plugin sait faire seul, sans conversation : la veille du jour, demain un résumé des mails. On sépare trois rôles :

| Rôle | Qui | Exemple |
|---|---|---|
| **Quoi** | Le plugin de la tâche (contrat `task`) | La Veille collecte, trie, écrit le digest |
| **Quand** | Un déclencheur : le plugin Planificateur (horloge), ou la voix (`run_task`) | « 07:30 », « à 8 h du lundi au vendredi », « toutes les 3 h » |
| **Annonce** | Le noyau | Notification « Ta veille est prête », document montré |

Une tâche ne connaît donc ni l'horloge ni les corps. Le Planificateur ne connaît aucune tâche en particulier.

```mermaid
flowchart LR
  M["Manifeste du plugin<br/>tasks: [{ id, label, schedule }]"] --> R
  R["Registre des tâches (noyau)<br/>un passage à la fois · délai max<br/>réveille le plugin s'il dort<br/>&lt;home&gt;/tasks.json"]
  H["Planificateur<br/>(horloge, rattrapage)"] -- "ctx.tasks.run(clé, clock)" --> R
  V["Voix : run_task"] -- "voice" --> R
  R -- "run()" --> P["Plugin (service task)"]
  P -- "{ summary, document, announce }" --> R
  R --> A["initiative + documents.show"]
```

## Déclarer une tâche

Dans le manifeste (lu sans démarrer le plugin, comme les slots) :

```ts
provides: ["task"],
tasks: [{ id: "daily", label: "Veille du jour", schedule: { at: "07:30" }, timeout_s: 900 }],   // { at, days? } ou { every }
```

Puis `ctx.provide("task", { run(taskId, { signal, reason, lastRun }) { … return { summary, document?, announce? } } })`.

- `reason` : pourquoi la tâche tourne (`clock`, `voice` ou `manual`).
- `lastRun` : début du dernier passage **réussi** (la veille s'en sert pour ne garder que les nouveaux articles).
- `announce` : `important` (dit à voix haute), `normal` (notification, par défaut), `silent`.

Une tâche peut aussi dire où sont ses réglages : `configure: "watch"`. Cette rubrique sort alors du menu de la fenêtre et s'affiche sous la tâche (Tâches → « Veille du jour » → Réglages). Un plugin qui ne sert qu'à une tâche n'encombre pas le menu.

## Le registre (noyau)

- Clé d'une tâche : `<entrée>/<tâche>` (ex. `watch/daily`). Une entrée désactivée n'a plus de tâches.
- Le noyau **garde le plugin en marche** pendant le passage (même un plugin `lazy`), puis le laisse s'arrêter.
- Outils du cerveau : `list_tasks` (liste) et `run_task` (écriture, accord ; lance en arrière-plan, le résultat arrive tout seul).
- API plugin : `ctx.tasks.list()`, `ctx.tasks.run(clé)`, `ctx.tasks.onChange(fn)`.

## Emprunter un slot : `ctx.borrow`

Une tâche a souvent besoin d'un élément choisi dans un slot (le cerveau du tri, le moteur de recherche). `ctx.slot` le garderait en marche tout le temps. `ctx.borrow(slot)` le démarre **le temps du travail** et `release()` le rend : un modèle n'occupe rien entre deux passages.

## Le Planificateur

- Rubrique **Tâches** : une fiche par tâche (prochain et dernier passage, résultat ou erreur du dernier essai, interrupteur, **Lancer maintenant**). La planification est dans la fiche, avec des choix tout prêts (07:00, 07:30, 08:00, 07:30 en semaine, toutes les 3 h, jamais).
- La planification est un réglage (clé `tasks.<entrée>.<tâche>`, et `tasks.<entrée>.<tâche>.send` pour les canaux d'envoi), modifiable à la voix : « Floppy, fais ma veille à 8 h ». Formes : `07:30`, `8h` ou `à 8h` (une **heure**), `07:30 lun-ven`, `09:00 week-end`, `toutes les 3h`, `toutes les 30 min`, `jamais`. La valeur gardée est écrite en anglais (`07:30`, `07:30 mon-fri`, `every 3h`, `every 30 min`, `never` ; envoi : `nowhere`) ; les formes françaises restent comprises quand on les dit ou les tape. Une période commence toujours par « toutes les ».
- Une horloge vérifie chaque minute, en heure murale : elle marche après une mise en veille du PC.
- **Rattrapage** : un passage manqué (PC éteint à 7 h 30) tourne une fois, 2 minutes après le démarrage.
- Changer l'heure ne déclenche pas de rattrapage immédiat. Une tâche en échec est réessayée 30 minutes plus tard, pas chaque minute.

## Rappels et minuteurs à la voix (implémenté, `plugins/tasks/scheduler/src/reminders.ts`)

- Outils : `set_reminder` (niveau `write` ; `text` et `in_minutes` **ou** `at` en `AAAA-MM-JJTHH:MM` local ; refuse le passé et plus d'un an ; rend l'heure prévue en clair), `list_reminders` (`read`), `cancel_reminder` (`write` ; par id `rN` ou par mots du texte, refuse l'ambigu). 50 rappels en attente au plus.
- Stockage : `<home>/scheduler/reminders.json` (écriture atomique). Ils survivent au redémarrage.
- Un seul `ctx.timeout` est armé sur le prochain rappel, par paliers de 20 jours au plus ; il est réarmé après chaque changement.
- À l'heure : annonce `initiative` d'importance `important`, source `scheduler`, clé `reminder:<id>`, texte dans la langue de l'assistant ; le rappel est ensuite retiré (une seule annonce).
- Rattrapage : un rappel passé pendant l'arrêt est annoncé `reminderStartupDelay_s` (10 s) après le démarrage, avec « en retard, prévu à HH:MM » si le retard dépasse 2 minutes.
- Accord : l'accord suit la règle du niveau `write`. Pour ne pas le demander à chaque rappel, une règle ciblée peut le lever (`approvals.toolRules`, source `scheduler`, outils `set_reminder` et `cancel_reminder`, niveau `write`, règle `always`), comme pour `correct_vocabulary`.

## Limites connues

- **Politesse** pas encore faite : le Planificateur ne sait pas si une conversation est en cours (aucun événement « tour en cours » sur le bus). À ajouter : un événement `turn.start` / `turn.end` émis par la conversation.
- `ctx.settings.declare` ne rend pas de quoi retirer un réglage : le réglage d'une tâche disparue reste visible jusqu'au redémarrage du Planificateur.
