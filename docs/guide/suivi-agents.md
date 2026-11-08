# Suivre ses agents nommés

Ouvre **Suivi des agents** dans le menu de l'icône Floppy, ou par un clic droit sur l'avatar. La fenêtre reste ouverte pendant le travail et réutilise son instance. Les changements de suivi actualisent les lignes sans ouvrir de fenêtre, reprendre le focus ou produire de notifications.

Chaque ligne montre le nom de l'agent ou de sa mission, son projet, son espace de travail s'il est connu, son activité, sa dernière progression ou raison d'attente disponible et l'âge de l'observation. Les groupes **À regarder**, **En cours** et **Terminé récemment** contiennent les agents eux-mêmes. Un agent absent, au repos, en attente, au résultat incertain ou dont l'observation est ancienne reste dans **À regarder**. Une réussite déclarée est distincte d'une présence en ligne.

Cherche un nom ou un projet, ou choisis un projet dans le filtre. Sélectionne une ligne pour lire la mission, les détails, la progression, la raison d'attente, le résultat déclaré, la dernière activité et les changements récents disponibles. Une donnée manquante porte la mention **Non renseigné par la source** ; Floppy n'invente ni progression ni raison d'attente. La sélection et le focus restent en place lors des mises à jour. Tab parcourt les commandes, Entrée ou Espace ouvre une ligne, les flèches haut/bas et Début/Fin déplacent le focus entre les lignes.

L'en-tête précise la connexion, la dernière synchronisation et la couverture. **Couverture partielle** signifie que des agents ou des faits peuvent manquer. Après deux minutes sans synchronisation ou observation récente, les données sont signalées comme anciennes. **Hors ligne** conserve les derniers faits connus ; une disparition ne prouve pas qu'une mission a réussi. **Actualiser** relit la source et signale un échec sans supprimer ces faits.

Le fournisseur conserve les observations dans le dossier de travail Floppy. Le plugin d'affichage `display-agent-tracking` consomme le service facultatif `agentTracking` de `@floppy/contracts`, sans dépendre de l'implémentation Orca. Sans fournisseur actif, le plugin reste actif, son menu reste disponible et sa fenêtre indique une source hors ligne. Désactiver le plugin retire son menu ; arrêter ou remplacer son fournisseur ferme sa fenêtre, retire les abonnements et révoque les lectures en cours, puis le cycle de vie réinscrit une vue avec le fournisseur actuel, ou hors ligne. Une panne de connexion d'un fournisseur toujours actif garde les derniers faits visibles. Les lectures sont limitées à 200 agents et 300 événements ; le détail affiche les 30 derniers événements de l'agent. Une liste tronquée est signalée comme partielle.

Le **Diagnostic technique**, fermé par défaut, montre seulement des métadonnées bornées : raisons, étapes et références de corrélation. Les messages, prompts, chemins et secrets ne font pas partie de ces traces. Les chemins et références techniques sont masqués dans les textes ordinaires. Aucun export automatique n'est créé.

Ouvrir la fenêtre ou sélectionner un agent ne lui envoie rien. Cette version n'ajoute pas de champ de question : le pipeline texte habituel ne porte pas encore un contexte de cible fiable jusqu'au cerveau. Pour l'ajouter, il faudra transmettre l'identifiant exact de l'agent et de son fournisseur dans le contexte interne du tour, tout en gardant le texte visible sous son nom et les envois sous le contrôle des accords existants.

## English — Track named agents

Open **Agent tracking** from the Floppy tray menu or by right-clicking the avatar. The window stays open and reuses its instance. Updates refresh rows without opening windows, stealing focus or producing notifications.

Each row shows the named agent or task, project, workspace when available, current activity, latest available progress or waiting reason, outcome and observation age. **Needs attention**, **In progress** and **Recently finished** contain individual agents. Absent, idle, waiting, uncertain or stale agents remain in **Needs attention**. A declared success is separate from live presence.

Search by agent or project, or filter by project. Select a row to inspect its mission, details, progress, waiting reason, declared result, latest activity and recent changes. Missing facts say **Not supplied by the source**. Updates preserve selection and keyboard focus. Tab moves between controls, Enter or Space opens a row, and Up/Down or Home/End moves between agent rows.

The header shows connection, last synchronization and coverage. Partial coverage means agents or facts may be missing. Observations and synchronization older than two minutes are marked stale. Offline mode preserves the last known facts; disappearance does not prove success. **Refresh** rereads the source and reports failure without clearing those facts.

The provider persists observations in Floppy's working folder. The `display-agent-tracking` display plugin consumes the optional, independent `agentTracking` service. Without an active provider the display plugin stays active, its menu remains available and its window shows an offline source. Disabling the display plugin removes its menu; stopping or replacing its provider closes its view, cleans up subscriptions and revokes pending reads, then the declared lifecycle registers a view using the current provider, or an offline view. Connection outages within an active provider preserve the last known facts. The window accepts up to 200 agents and 300 events, shows up to 30 recent events per selected agent, and marks a truncated agent list as partial.

The collapsed **Technical diagnostics** contains bounded metadata only: reasons, stages and correlation references. Conversation content, prompts, paths and secrets are excluded. Ordinary labels hide paths and technical references; no automatic export is created.

Opening or selecting never sends an agent command. Questions are not included in this version: the existing text pipeline needs reliable internal context carrying the exact provider and agent identity before a question box can safely target a named agent through Floppy and its existing approvals.
