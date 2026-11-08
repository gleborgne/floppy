# Faire retenir les noms mal reconnus

Floppy peut retenir tes corrections de noms dans leur contexte : canal Teams, projet Orca, etc. La mémoire reste dans ton dossier Floppy et fonctionne avec le cerveau local, les agents CLI et le mode Live.

## Corriger un nom

Si « Core Team » est transcrit « court team », dis **« Non, je dis Core Team »**. Tu peux aussi écrire **« Corrige court team en Core Team »** dans la conversation si la voix continue à mal reconnaître le nom corrigé.

Une réponse comme « non, Alice » ou « je veux dire Alice » peut être un changement d'avis : elle n'est pas retenue comme une correspondance permanente. Pour corriger la reconnaissance, indique ce que tu as dit, ou nomme explicitement les deux formes. Dans « non, je dis Core Team », la variante mal reconnue doit venir de la demande précédente ; les mots de cette réponse ne servent pas de variante à mémoriser.

Précise l'équipe ou le compte si plusieurs canaux portent ce nom. Floppy retient la correspondance après l'appel réussi à son outil ; dire « c'est retenu » sans écriture ne suffit pas. Les demandes suivantes peuvent utiliser cette correspondance. Le moteur STT lui-même n'est pas réentraîné.

La correction concerne les noms de cibles. Elle ne remplace pas des mots dans le texte d'un message à envoyer ou dans la dictée libre.

## Consulter et oublier

- « Liste mes corrections de vocabulaire. »
- « Oublie la correction court team vers Core Team. » Floppy retrouve son identifiant puis demande l'accord avant de la supprimer.
- Pour changer une correspondance existante, formule la nouvelle correction explicitement ; Floppy doit relire sa version avant de la remplacer.

## Activer sur une configuration existante

La configuration d'exemple inclut les plugins et une autorisation limitée aux corrections explicites. Un fichier `floppy.yml` existant n'est pas remplacé lors d'une mise à jour. Ajoute ces entrées **aux listes existantes**, sans remplacer tes autres réglages :

```yaml
plugins:
  - { id: memory, plugin: memory }
  - { id: vocabulary, plugin: vocabulary }

approvals:
  write: ask
  send: ask
  delete: ask
  toolRules:
    - { source: vocabulary, tool: corriger_vocabulaire, level: write, rule: always }
```

Ne duplique pas l'entrée `memory` si elle existe déjà. `source` doit correspondre à l'id de ton entrée de vocabulaire. Sans cette autorisation ciblée, chaque correction demande l'accord ; les autres écritures et envois gardent leurs règles normales. `write: never` interdit toujours ces écritures.

Dans **Écoute → Vocabulaire personnel**, désactive « Retenir mes corrections sans redemander » pour faire confirmer chaque correction. Ce réglage ne donne pas de droit absent de la configuration. L'oubli demande toujours confirmation.

Seul le fournisseur local est actuellement livré. Les fournisseurs externes pourront utiliser le contrat mémoire indépendant ; une prise en charge des corrections est nécessaire pour cette fonction.

## Auditer le fonctionnement

Pendant que Floppy tourne, exécute `floppy log 200` pour lire les 200 derniers événements. Le journal complet courant est `audit.jsonl` dans le dossier Floppy choisi dans les réglages ; le fichier précédent après rotation s'appelle `audit.1.jsonl`.

Pour comprendre une correction qui ne fonctionne pas :

1. Reproduis la demande et la correction. Retrouve les événements `kind: "vocabulary"` et leur `turn` (le tour de conversation).
2. Cherche `correction.proposed`, puis `correction.accepted` ou `correction.rejected`. Le champ `reason` indique par exemple une preuve absente, un tour différent ou un refus du noyau. Les événements `approval` et `tool` du même `callId` montrent la décision et le résultat.
3. Une écriture réussie apparaît aussi comme `kind: "memory.store"`, opération `correction.save`, avec son identifiant et sa version.
4. À la demande suivante, `context.selected` indique les identifiants de corrections fournis au cerveau. Cela ne prouve pas qu'il les a suivies : regarde aussi ses appels d'outils du même tour. `resolution.completed` concerne les appels au service de résolution lorsqu'il est utilisé.
5. Pour un problème de lenteur ou de disponibilité, regarde `memory.context` (`outcome`, `duration_ms`) et `provider.error` côté vocabulaire.

Les nouvelles traces gardent des métadonnées par défaut. Pour examiner le texte exact pendant un diagnostic, active **Écoute → Vocabulaire personnel → Inclure le texte des corrections dans le journal**, puis désactive-le après reproduction. Cette option ajoute des traces `correction.trace` bornées ; elle n'ajoute pas tout le contexte du cerveau. Elle ne supprime pas les traces déjà écrites lorsqu'on la désactive. Les journaux habituels de Floppy peuvent déjà contenir des transcriptions : vérifie leur contenu avant de les partager.

Pour mesurer une amélioration sur plusieurs essais, compare les corrections rejetées par motif, les délais du contexte, les corrections fournies au cerveau et les appels réellement réussis. Le journal tourne à taille limitée ; exporte les événements nécessaires à une comparaison avant leur rotation.
