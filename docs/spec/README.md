# Spec : assistant vocal personnel à plugins

Version 0.2 — 4 novembre 2026. Issue de l'interview, puis des prototypes 1 à 3 ter (ancien prototype Hermes écarté, cerveau AI SDK), complétée par les agents externes.

Le projet s'appelle **Floppy**. Dans cette spec, **« l'assistant »** désigne le produit ; « Floppy » est aussi le nom qu'on lui donne à la voix (réglable).

## Résumé

- Un assistant vocal **toujours actif** sur le PC. On l'appelle avec un mot d'activation (« Floppy »).
- Il est **local par défaut**. Le cloud est permis seulement pour les plugins que l'utilisateur active.
- **Le cerveau est un plugin.** Montage A : agent Vercel AI SDK + Gemma 4 12B en local (~1,1 s avec un outil), qui délègue les demandes difficiles à Claude ou Codex. Montage B, sans GPU : le CLI Claude ou Codex est le cerveau (Claude Haiku : 100 % juste, ~2 s). Les outils, l'accord, la mémoire et les tâches planifiées restent dans le **serveur MCP « Floppy »** du noyau. Les nouveaux adaptateurs et les travaux suivis sont décrits dans [Agents externes](agents-externes.md).
- **Tout est plugin** : la voix, le corps, l'affichage, le modèle du cerveau, et les outils.
- **Deux modes de cerveau.** Mode **séparé** : notre cerveau décide, et une voix comme Gemini Live sert seulement d'oreilles et de bouche. Mode **live** : un modèle live (Gemini Live, GPT Live) est à la fois la voix et le cerveau. Dans les 2 modes, les outils, la mémoire, les droits et les accords restent gérés par notre noyau.
- **Sécurité** : chaque plugin déclare ses droits, et l'utilisateur les accorde. Lire est libre dans ces droits. Écrire, envoyer ou supprimer demande un accord.
- Projet **open source (MIT)**, Windows d'abord, langue configurable, nom et mot d'activation configurables.
- **v1** : assistant toujours actif sur le PC, Obsidian et navigateur, outils de travail (Office 365, Azure DevOps, Orca).

## Sommaire

Guides pas à pas pour les utilisateurs : [docs/guide](../guide/README.md).


| Fichier | Contenu |
|---|---|
| [Le premier proto (implémenté)](proto.md) | Lancer, ce qui tourne, un tour vocal, accord à la voix, cerveau v3c, mesures (à refaire), tests (265) |
| [Le noyau (implémenté)](noyau.md) | Plugins, frontières entre plugins, cycle de vie, services (contrats), config, outils et accords, CLI |
| [Réglages à la voix (implémenté)](reglages.md) | Régler l'assistant en lui parlant ou dans la fenêtre : risques, voix, ton, affichage, CLI |
| [Éléments : réglages pilotés par les plugins (implémenté)](elements.md) | Rubriques déclarées par les plugins ; ajouter, désactiver, supprimer modèles, voix, connecteurs, corps, avatars ; formulaires générés ; secrets ; fr/en |
| [Recherche web et fenêtre A2UI (implémenté)](a2ui.md) | Chercher sur internet avec ton abonnement Claude ou Codex ; résultats dans une fenêtre A2UI ; avatar qui dort au démarrage |
| [Assistant IA et plugins utilisateur (implémenté)](assistant-ia.md) | Ton Claude ou ton Codex dans la fenêtre des réglages ; écrire ses propres plugins |
| [Plugins tiers (implémenté)](plugins-tiers.md) | Installer un plugin d'un autre (dossier, zip, git) : contrôles, revue par un agent IA, clic, processus isolé, mode debug, SDK |
| [Vrais outils (implémenté)](outils-reels.md) | Connecteurs MCP, Azure DevOps distant, Orca, initiatives |
| [Tâches et Planificateur (implémenté)](taches.md) | Contrat `task`, registre du noyau, horloge et rattrapage, `ctx.borrow` |
| [Documents Markdown (implémenté)](documents.md) | Floppy répond par un document dans une fenêtre ; fichiers .md ; sécurité du rendu |
| [Boîte aux lettres (implémenté)](boite-aux-lettres.md) | Les applications locales déposent des annonces ; accord par app ; voix ou info ; « ouvre-la » lance leur lien |
| [Notifications (implémenté)](notifications.md) | Contrat `notify`, canaux Telegram et mail, « Envoyer à » par tâche, outil `send_document` |
| [Veille (implémenté)](veille.md) | Centres d'intérêt, flux RSS et recherches, pré-tri en code, tri par un modèle, digest quotidien, avis à la voix |
| [Télécharger des modèles (implémenté)](telechargements.md) | Bibliothèque de modèles dans les réglages : modèles choisis, recherche Hugging Face, `ctx.downloads`, barre d'avancement |
| [Premier lancement (implémenté)](premier-lancement.md) | Lire la machine (carte séparée ou mémoire unifiée), niveaux du texte seul au tout local, fenêtre « Bienvenue », test de vitesse |
| [Écoute en plugins (en cours)](ecoute.md) | Contrats `vad` et `stt`, plugin Écoute (règles reprises de Python), lecteur sherpa-onnx, retrait de Python |
| [Corps, émotions et avatar (implémenté)](corps-et-avatar.md) | Plusieurs corps, protocole v0, émotions, avatar WebGL |
| [Architecture](architecture.md) | Noyau, services, couche de plugins, manifeste, protocole noyau ↔ corps, services Python |
| [Le cerveau](cerveau.md) | Vercel AI SDK, modèle par défaut, boucle d'un tour, ce qu'on écrit nous-mêmes, modèle de décision retiré, budget VRAM, prototypes |
| [Agents externes](agents-externes.md) | Offres de plugins, OpenCode, Pi, Oh My Pi, Hermes, sessions Copilot/Cursor/Aider, missions nommées et travaux suivis |
| [Intégration avec Hermes (abandonnée)](hermes.md) | Historique : pourquoi Hermes, ses leçons de sécurité et d'abonnements |
| [Sécurité](securite.md) | Principes, droits et niveaux d'outil, accord, secrets cloisonnés, garde-fous du code et limite connue, journal |
| [Fonctionnement](fonctionnement.md) | Tour de conversation, tâches longues, initiatives, config à la voix |
| [Mémoire, skills, ton et langue](memoire-skills-ton-langue.md) | Mémoire et skills (inspirées de Hermes), ton, langue et nom |
| [Périmètre de la v1 et après](v1-et-apres.md) | Contenu v1, cas d'usage et critères, performance, suite |
| [Questions ouvertes](questions-ouvertes.md) | Décisions encore à prendre |
| [Réutilisation des prototypes](prototypes.md) | Ce qu'on reprend de `cascade\`, `lfm3\`, `reachy\` |

## Objectifs et non-objectifs

### Objectifs

1. Parler à l'assistant naturellement, en mains libres, avec un temps de réponse d'environ 1 s.
2. Changer de cerveau, de voix ou de corps par simple config, ou à la voix.
3. Ajouter une capacité en ajoutant un plugin, sans toucher au noyau.
4. Ne jamais mettre en danger le PC : l'assistant touche seulement ce qu'on lui a donné.
5. Se souvenir de ce qui a été fait, et ne pas refaire les mêmes erreurs.

### Non-objectifs (v1)

- macOS et Linux (le code reste portable).
- Corps Reachy, téléphone, Telegram, WhatsApp (prévus, pas dans la v1).
- Sonos et domotique.
- Skills avec du code.
- LiveKit.
- Plusieurs utilisateurs.

## Décisions

| Sujet | Décision |
|---|---|
| Base du cerveau | **Plugin `brain`** : AI SDK + LLM local ou agent CLI (Claude, Codex, Antigravity, OpenCode, Pi, Oh My Pi, Hermes). Les outils passent par le **serveur MCP « Floppy »** du noyau. Voir [Le cerveau](cerveau.md) et [Agents externes](agents-externes.md). |
| Cerveau | 2 modes. **Séparé** : notre cerveau décide, les voix live servent seulement d'oreilles et de bouche. **Live** : le modèle live est aussi le cerveau ; il appelle nos outils, et il peut passer une tâche complexe au cerveau séparé. Outils, mémoire, droits et accords restent toujours dans le noyau. |
| Modèle du cerveau | Montage A (GPU) : **Gemma 4 12B, réflexion coupée**, qui délègue à Claude Sonnet ou Codex. Montage B (sans GPU) : **Claude Haiku** par le CLI, Sonnet ou Codex en option. Clé API proposée partout ; abonnement par les CLI officiels en option « à vos risques » (conditions d'utilisation). |
| Modèle de décision | **Retiré de la v1** : aucun petit modèle n'a fait mieux que Gemma seul (prototype 3 ter). LFM3 d1-2B a aussi une licence incompatible. Gemma 4 E2B est à mesurer plus tard pour le choix local ou cloud. |
| Langage | Noyau de l'assistant, cerveau et plugins en **TypeScript** (Node 24). Modèles locaux = services **Python** ou natifs (llama.cpp). |
| Couche de plugins | **Notre propre couche**, inspirée de Cordis (services, dépendances, effets, hooks). Pas de dépendance à Cordis. |
| Isolation | Les « mains » sont des serveurs MCP et des CLI **hors processus**, lancés par le noyau. Le noyau contrôle chaque appel et demande l'accord. Pas de terminal ni d'exécution de code en v1. |
| Cloud | Local par défaut. Chaque plugin cloud s'active explicitement. Le mot d'activation reste toujours local. |
| Sécurité | Droits déclarés par plugin et accordés une fois. Lire = libre dans les droits. Écrire, envoyer, supprimer = accord (voix ou clic). |
| Mémoire | **À nous, inspirée de Hermes** : `USER.md` et `MEMORY.md` limités et toujours dans le prompt, historique en SQLite FTS5, écritures par l'accord. |
| Skills | **À nous**, format `SKILL.md` (agentskills.io), chargées à la demande. Une skill n'ajoute aucun droit. |
| Ton | Change les **mots**, la **voix** et le **corps**. Ne change pas le comportement. |
| Affichage | **Bulle** qui apparaît, agrandissable en fenêtre. UI générée en **A2UI**, et **MCP Apps** pour les outils de tiers. |
| Écoute | Icône d'état, raccourci clavier, commande vocale (« Floppy, dors »). |
| Initiatives | Selon l'importance : important = à voix haute ; le reste = notification visuelle. |
| Config | En CLI ou à la voix. Accord selon le risque. |
| Projet | Open source dès le début, licence **MIT** (Apache-2.0 possible si besoin). Dépendances permissives seulement : pas de licence « source disponible » (ELv2, BSL, SSPL, parties « entreprise »). Windows d'abord. Langue, nom et mot d'activation configurables. |
