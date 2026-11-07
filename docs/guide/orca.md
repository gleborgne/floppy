# Suivre ses agents Orca avec Floppy

[← Tous les guides](README.md)

Floppy surveille les agents de code qui tournent dans **Orca**. Il te prévient quand un agent a fini ou attend ta réponse. Tu peux aussi lui demander où en est un agent, sans quitter ce que tu fais.

Ce guide prend 2 minutes.

## 1. Ajouter Orca dans Floppy

1. Ouvre **Réglages → Connecteurs**, puis ajoute **Orca**.
2. Garde Orca ouvert.

Floppy regarde maintenant l'état des agents toutes les 15 secondes. Une fin d'agent est donc annoncée avec jusqu'à 15 secondes de retard.

## 2. Être prévenu tout de suite (conseillé)

Un petit plugin, installé dans Orca, prévient Floppy **dès qu'un agent change d'état**. L'annonce arrive alors en moins d'une seconde.

1. Ouvre **Réglages → Connecteurs → Orca**.
2. Clique **« Installer dans Orca »**. Orca doit être ouvert.

Le plugin demande à Orca un seul accès : **être prévenu quand l'état d'un agent change**. Il ne lit pas ton code et n'écrit rien dans les terminaux. En cliquant, tu donnes cet accord à Orca. Si Orca demande un autre accès, Floppy n'autorise rien et te le dit.

Ensuite :

- Le plugin démarre au **premier changement d'état d'un agent**, pas avant.
- Dès qu'il parle à Floppy, l'état d'Orca dans les Réglages devient **« prévenu tout de suite (plugin Orca actif) »**. Avant, il affiche « vérifie toutes les 15 s ».

À la voix, dis **« Installe le plugin Orca »** ou **« Ouvre les réglages d'Orca »**. Floppy n'installe rien lui-même : il ouvre la bonne page des réglages et te dit sur quel bouton cliquer.

### Après une mise à jour de Floppy

Si le plugin a changé, le bouton devient **« Mettre à jour dans Orca »**. Clique dessus.

## 3. Choisir ce que Floppy te dit

Dans **Réglages → Connecteurs → Orca**, le réglage **« Annonces des agents Orca »** a trois choix :

| Choix | Ce qui se passe |
|---|---|
| **Tout dire** | Chaque fin d'agent est dite à voix haute. |
| **Si un agent attend** (par défaut) | À voix haute seulement quand un agent attend ta réponse. Les fins s'affichent par écrit, sans voix. |
| **Rien** | Floppy ne surveille plus Orca. Tu peux toujours lui poser des questions sur tes agents. |

L'interrupteur en haut de la page allume ou éteint Orca entier dans Floppy : les annonces **et** les questions.

## 4. Ce que tu peux demander

- « Où en sont mes agents ? »
- « Qu'est-ce qu'il demande ? » : Floppy prend l'agent qu'il vient d'annoncer, ou le seul qui attend.
- « Montre-moi l'écran de l'agent de la migration » : Floppy lit le terminal de l'agent et te le résume.
- « Quel agent a travaillé sur le cache ? », « Qu'est-ce qu'on avait décidé pour les dates ? » : Floppy cherche dans les conversations de tous tes agents. Il faut d'abord allumer la recherche dans Orca : **Réglages → Agent Session History**.

Les noms de projets mal compris par la dictée sont tolérés : « différendum » trouve `differendum`.

Floppy **ne fait rien** dans Orca. Il ne tape rien dans les terminaux et ne change pas d'onglet. Il t'informe, c'est tout.

## Ça ne marche pas ?

| Ce que tu vois | Quoi faire |
|---|---|
| « Orca ne répond pas » | Ouvre Orca. |
| Pas de « prévenu tout de suite » | Le plugin attend le premier changement d'état d'un agent. Lance un agent, puis regarde à nouveau. |
| Toujours rien | Dans un terminal, tape `orca plugin logs local.floppy`. Le plugin y écrit pourquoi il ne joint pas Floppy. |

Pour savoir comment ça marche à l'intérieur : [spec, section Orca](../spec/outils-reels.md#orca-plugin-orca).
