# Suivre ses agents Orca avec Floppy

[← Tous les guides](README.md)

Floppy suit individuellement les agents de code d'**Orca**, avec un nom de tâche et un projet. Tu peux consulter la fenêtre **Agents**, demander un récapitulatif et poursuivre sur un agent sans changer d'onglet dans Orca. Une fin indique seulement une fin observée : elle ne prouve ni la réussite du travail ni un commit.

Ce guide prend 2 minutes.

## 1. Ajouter Orca dans Floppy

1. Ouvre **Réglages → Connecteurs**, puis ajoute **Orca**.
2. Garde Orca ouvert.

Floppy regarde maintenant l'état des agents toutes les 15 secondes. Une fin d'agent est donc annoncée avec jusqu'à 15 secondes de retard.

## 2. Être prévenu tout de suite (conseillé)

Un petit plugin, installé dans Orca, transmet le changement d'état **dès qu'il arrive**. Floppy accepte le fait, puis lit les informations utiles pour préparer l'annonce ; une lecture lente peut retarder cette annonce.

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

L'annonce nomme le thread et résume en une phrase ce que l'agent a fait, par exemple « L'agent a terminé de restructurer les notes ». Si l'agent demande une réponse ou une validation pour la suite, une seconde phrase le précise. Floppy ne relit pas le rapport complet. Le réglage **« Synthèse des agents Orca »** choisit le modèle utilisé pour ce résumé ; s'il est indisponible, Floppy annonce seulement l'état connu.

Cacher l'avatar ne coupe pas les annonces vocales. Le mode veille (« Floppy, dors ») les met en attente jusqu'au réveil.
Le bouton « Arrêter l'écoute » près de « Je t'écoute… » ferme uniquement l'écoute active : Floppy revient au repos et continue de lire les notifications importantes.

Dans **Réglages → Connecteurs → Orca**, le réglage **« Annonces des agents Orca »** a trois choix :

| Choix | Ce qui se passe |
|---|---|
| **Tout dire** | Chaque fin d'agent est dite à voix haute. |
| **Si un agent attend** (par défaut) | À voix haute seulement quand un agent attend ta réponse. Les fins s'affichent par écrit, sans voix. |
| **Rien** | Aucune annonce. Floppy continue de suivre les agents et tu peux consulter leur état ou leur historique. |

L'interrupteur en haut de la page allume ou éteint Orca entier dans Floppy : le suivi, les annonces **et** les questions. L'ancien choix « aucune » ou « surveillance : non » devient ce mode silencieux ; pour arrêter la collecte, éteins le connecteur.

## 4. Ce que tu peux demander

- « Où en sont mes agents ? » : une liste nommée et ordonnée, avec un résumé individuel. Tu peux préciser un projet, un état ou une date.
- « Celui sur les mails », « le deuxième », « il a changé quoi ? » : Floppy reprend le groupe présenté ou l'agent dont tu parles dans cette conversation. Les conversations de deux corps restent séparées. Une notification silencieuse d'un autre agent ne change jamais « lui ».
- « Montre-moi l'écran de l'agent de la migration » : Floppy lit le terminal de l'agent et te le résume.
- « Quel agent a travaillé sur le cache ? », « Qu'est-ce qu'on avait décidé pour les dates ? » : Floppy cherche dans les conversations de tous tes agents. Il faut d'abord allumer la recherche dans Orca : **Réglages → Agent Session History**.
- « Qu'est-ce qui a changé sur Floppy depuis ce matin ? » : Floppy récapitule les faits observés (48 heures au maximum), en nommant les agents. Une période sans observation ne prouve pas une inactivité.
- « Dis-lui de commit », « Demande-lui de corriger les tests » : après avoir parlé de cet agent, Floppy propose la consigne avec son nom et son projet. Le projet « Floppy » seul reste ambigu si plusieurs agents y travaillent.
- « Demande-leur de faire le commit » : le groupe présenté est figé pour l'accord. Les agents d'un même dossier passent successivement, après la fin observée du tour précédent. Demande ensuite où en sont les envois ; une transmission acceptée ne prouve pas un démarrage ou un commit.
- « Diagnostic Orca » : état de la liaison, dernière synchronisation, couverture incomplète et traces techniques limitées, sans texte de tes demandes.

Les noms de projets mal compris par la dictée sont tolérés : « différendum » trouve `differendum`.

Floppy transmet tes consignes aux agents ouverts dans un terminal Orca, sans changer d'onglet. S'il ne peut pas identifier un agent unique, il demande de préciser. Les chats sans terminal et les workers pilotés par un coordinateur ne sont pas pris en charge pour l'envoi. Une consigne transmise ne signifie pas que l'agent a déjà fait le travail.

Si un agent disparaît ou si la référence de conversation expire, Floppy le dit et demande de refaire la liste. Il ne choisit jamais un autre agent à sa place. Les références ne sont pas conservées après un redémarrage et expirent après 30 minutes sans utilisation.

La fenêtre **Agents** montre les derniers faits, leur âge, la présence connue ou inconnue et la connexion. « Terminé », « réussite déclarée » et « présent » sont trois informations distinctes. En mode Live, une annonce envoyée à la voix est marquée comme programmée ; Floppy ne peut pas certifier qu'elle a été entendue.

## Ça ne marche pas ?

| Ce que tu vois | Quoi faire |
|---|---|
| « Orca ne répond pas » | Ouvre Orca. |
| Pas de « prévenu tout de suite » | Le plugin attend le premier changement d'état d'un agent. Lance un agent, puis regarde à nouveau. |
| Toujours rien | Dans un terminal, tape `orca plugin logs local.floppy`. Le plugin y écrit pourquoi il ne joint pas Floppy. |

Pour savoir comment ça marche à l'intérieur : [spec, section Orca](../spec/outils-reels.md#orca-plugin-orca).
