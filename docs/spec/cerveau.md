# Le cerveau : Vercel AI SDK et LLM local

[← Retour à la spec](README.md)

Décision du 4 novembre 2026, après les prototypes 3 à 3 quater : **le cerveau est un plugin du noyau**. Par défaut, un agent Vercel AI SDK avec Gemma 4 12B en local. Sans GPU, le CLI Claude ou Codex sert de cerveau. L'ancien montage Hermes avait été écarté, trop lent et trop lourd pour la voix (voir [l'ancienne intégration avec Hermes](hermes.md), gardée pour l'historique).

Légende : **[M]** mesuré par un prototype. **[I]** déduction, à vérifier.

Depuis le 7 novembre 2026, [les agents externes](agents-externes.md) ajoutent OpenCode, Pi, Oh My Pi et un nouvel adaptateur Hermes comme cerveau ou délégué, ainsi que les missions nommées et les travaux suivis. Le rejet d'Hermes mentionné ci-dessus concerne l'ancien prototype ; ses mesures ne portent pas sur ce nouvel adaptateur. Copilot, Cursor et Aider sont disponibles en sessions interactives.

## Pourquoi ce choix

Mêmes demandes, même faux serveur MCP de travail, même llama-server [M] :

| Montage | Réponses justes | Temps avec un outil | Premier appel | VRAM du LLM |
|---|---|---|---|---|
| Hermes + Qwen3.6-35B-A3B | 80 % | 11,8 s | 14,9 s | 9,6 Go (contexte 64k exigé) |
| Hermes + Codex (cloud) | 95 % | 13,4 s | 7,3 s | — |
| AI SDK + Qwen3.6-35B-A3B | 75 % (70 à 80) | 2,4 s | 5,5 s | 9,0 Go |
| **AI SDK + Gemma 4 12B, réflexion coupée** | **87 % (85 à 90)**, ~92 % en acceptant les nombres en lettres | **1,1 s** | **0,7 s** | **8,0 Go** (contexte 32k) |

Chiffres AI SDK : 20 demandes nouvelles, jamais vues pendant la mise au point du prompt, 3 passages (moyenne et écart). Détails : `prototypes\local-models\`, `prototypes\frameworks\`, `prototypes\decision\`.

Ce que Hermes coûtait : un prompt d'environ 13 000 tokens, un contexte de 64k minimum, une recherche d'outil en 2 ou 3 tours de modèle, des tâches annexes qui occupaient le LLM 5 à 15 s après chaque réponse, une skill `obsidian` qui détournait les modèles locaux, et une version qui change presque tous les jours.

## Le framework : Vercel AI SDK

- Paquet `ai` (v7), **Apache-2.0**, compatible avec un projet MIT. Léger : 21 paquets, 27 Mo [M].
- Fournit : boucle d'agent avec appels d'outils, streaming, **accord natif des outils** (`toolApproval`), client MCP qui garde les annotations des outils (`readOnlyHint`, `destructiveHint`), tout serveur compatible OpenAI (llama.cpp) et les fournisseurs cloud.
- Ne fournit pas : mémoire, skills, tâches planifiées. On les écrit (voir plus bas).
- Option de repli : **OpenAI Agents SDK (JS)**, MIT, si on veut un état d'accord sauvegardable et des sessions toutes faites. Couper ses traces vers OpenAI.
- Écartés : **Mastra** (parties « Enterprise » sous licence non libre, télémétrie par défaut), **VoltAgent** (installe des paquets SAP sous licence propriétaire), Google ADK TS (pas de modèle compatible OpenAI), LlamaIndex.TS (archivé), LangGraph.js (trop de couches pour un seul agent).

## Deux montages, un seul noyau

Le cerveau est un **plugin**. Trois adaptateurs du service `brain`, qui utilisent tous le **même serveur MCP « Floppy »** du noyau (outils, accord, mémoire, tâches planifiées). Mesures : prototype 3 quater, `prototypes\cli-brain\` [M].

| | Montage A : Gemma + gros LLM | Montage B : gros LLM seul (sans GPU) |
|---|---|---|
| Cerveau principal | AI SDK + Gemma 4 12B en local | CLI **Claude** (défaut : Haiku) ou CLI **Codex** |
| Gros LLM | outil `deleguer(tache)` vers le CLI Claude (Sonnet) ou Codex | — |
| Pour qui | PC avec un GPU d'environ 16 Go ou plus | tout PC ; abonnement Claude ou ChatGPT, ou clé API |
| Voix | cascade locale sur GPU | voix légère sur processeur (Parakeet, Kokoro), ou Gemini Live |

### Résultats (40 demandes, 1 passage)

| Cerveau | Réponses justes | Sans outil, premier mot | Avec un outil, total |
|---|---|---|---|
| Gemma 4 12B (AI SDK) | 87 % (nouvelles), 95 % (anciennes) | 0,3 s | ~1,1 s |
| **CLI Claude Haiku** | **100 %** | 0,9 s | **2,1 s** |
| CLI Claude Sonnet | 100 % | 0,7 s | 2,6 s |
| CLI Codex (modèle par défaut) | 100 % | 2,7 s | 8,6 s |
| CLI Codex Luna, effort moyen | 95 % | 2,8 s | 6,2 s |
| CLI Codex Luna, effort bas / aucun | 90 % / 88 % | 2,2 à 2,7 s | 6,0 à 6,4 s |
| CLI Antigravity (`agy`), Gemini Flash effort bas | 95 % | 3,1 s | 6,8 s |

Avec Codex seul, le montage B utilise **Luna en effort moyen**. L'effort « aucun » est à éviter : sur une demande ambiguë, il a lancé une écriture sans vraie tâche (l'accord l'aurait arrêtée). Luna ouvre mal les liens (`ouvrir_url`) à tous les niveaux d'effort.

Montage A : quand Gemma délègue, il dit d'abord une phrase d'attente (~0,7 s), puis la réponse arrive vers 5,5 s avec Sonnet et 11 à 14 s avec Codex (Luna n'est pas plus rapide ici : les demandes difficiles demandent plusieurs outils). **Délégation par défaut : Claude Sonnet** ; avec Codex seul, le modèle par défaut. **Corrigé par le prototype 4** (`prototypes\ambiguity\`, 31 demandes nouvelles, 3 passages) :
- **Prompt v3** : trois chemins (demander une précision, déléguer, faire), avec 8 exemples courts, et une description plus précise de `deleguer`. Gemma délègue alors **100 %** des demandes difficiles (avant : 29 %). Il pose une question pour **100 %** des demandes ambiguës. Aucune délégation ni question en trop.
- **Règle du noyau** : dès que le flux contient l'appel à `deleguer`, le code dit la phrase d'attente (**~0,7 s**). Ensuite, il lit la réponse du gros LLM directement : Gemma ne la répète pas. Réponse complète vers **6 s** avec Sonnet.
- Un outil `demander_precision` n'apporte rien : il est retiré.
- **Phrases d'attente variées** (2026-11-05, idée de la vidéo « local voice agent » de Codacus) : la délégation tire une phrase au hasard dans `waitingPhrases`, jamais la même deux fois de suite (`waitingPhrase` garde une phrase fixe si on la donne). En voix, si le modèle reste muet plus de `readFillerMs` (2 s) après le résultat d'un outil (il lit un long résultat), le cerveau dit une phrase de lecture (`readPhrases`). Une seule phrase d'attente par tour. Audit : `read_filler`.
- **Petits bouts collés** : après la 1re phrase, un morceau de 3 mots ou moins attend la phrase suivante (`SentenceSplitter.MIN_WORDS`) ; la voix sonne moins hachée. La 1re phrase part toujours seule.
- **Réglages llama.cpp par modèle** (fenêtre Cerveau → LLM local, ou `floppy.yml`) : `spec` (none / mtp / draft / ngram ; MTP avec ou sans fichier séparé), `placement` (gpu / moe + `nCpuMoe` / auto = `--fit on` avec `gpuMargin` Mo libres), `ctx`, `ubatch` (-ub, -b = max(ub, 2048)), `kv` (f16 / q8_0 / q4_0), `mmproj` (vision), `reasoning` (off / on / **tools**). Ces champs gagnent sur les arguments avancés (`buildArgs`, `splitArgs`). Ordre conseillé pour la mémoire GPU gagnée : d'abord moins d'experts en RAM et `-ub` plus grand (prefill), puis le contexte.
- **Réflexion « tools »** : llama-server tourne avec `--reasoning on` ; le cerveau envoie `chat_template_kwargs.enable_thinking = false` à la 1re étape du tour et `true` aux suivantes (après un outil). Réglé ainsi pour Qwen3.6 35B.
- **Latence mesurée depuis la vraie fin de parole** : le service voix envoie `silence_ms` (silence attendu par le VAD, 500 ms ; 0 en push-to-talk) et le tour démarre son horloge à `fin du transcript − stt_ms − silence_ms`. `first_audio` est donc le délai ressenti.
- Reste à corriger : le calcul d'heures (« 9 h 40 + 2 h 15 »). Gemma se trompe à chaque fois. Solution : un outil de calcul d'heures dans le noyau.

### Le serveur MCP « Floppy »

- Le noyau ouvre un serveur MCP local (HTTP sur `127.0.0.1`, jeton créé à chaque démarrage ; sans jeton : refus).
- Il relaie les serveurs MCP de l'utilisateur et ajoute les outils « corps » (`afficher_carte`, `dire`, `notifier`) et les outils internes (mémoire, tâches planifiées).
- **L'accord est fait dans ce serveur**, au moment de l'appel. Le même code protège tous les cerveaux. Aucun outil ne permet au modèle de répondre à l'accord.

### Les adaptateurs CLI (réglages vérifiés)

- **Claude** : `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --tools "" --strict-mcp-config --mcp-config <floppy> --allowedTools mcp__floppy --permission-mode dontAsk --setting-sources project --disable-slash-commands --no-session-persistence --system-prompt <prompt>`. Depuis le 8 novembre 2026, un processus persistant par conversation : après `result`, stdin reste ouvert pour la demande suivante. Une réserve prépare le premier tour ; aucune relance entre deux réponses normales. `reset` ferme le processus. Interruption, délai dépassé, erreur ou sortie du programme invalident la session ; le prochain tour repart avec les échanges récents. Changer le modèle ou les outils invalide aussi les sessions (après la réponse pour un tour actif). `--no-session-persistence` empêche l'enregistrement sur disque, pas la conservation en mémoire. `--bare` est impossible : il coupe la connexion à l'abonnement.
- **Codex** (plugin `brain-codex-cli`) : `codex app-server` (JSON-RPC), un fil de conversation par session (oublié au `reset`), notre prompt en `baseInstructions`, bac à sable en lecture seule, environ 20 fonctions coupées par `-c`. Les serveurs MCP de l'utilisateur sont coupés un par un, par leur nom. `apply_patch` reste visible mais il est bloqué par le bac à sable.
- **Ton et historique Claude/Codex** : `CliConversation` (`@floppy/agent-cli`) ajoute la préférence de ton au premier message qui en porte une, puis seulement lorsqu'elle change (y compris sa suppression). La consigne ne concerne que la formulation, jamais les outils ou les accords. Le ton traverse aussi `deleguer`. Les adaptateurs déclarent `BrainService.keepsHistory` : AI SDK transmet le texte courant seul, avec une copie structurée des échanges récents dans `BrainRunInput.history`. Cette copie reste côté Floppy tant que la session CLI existe ; elle n'est ajoutée au prompt qu'à l'ouverture d'une nouvelle session. `context` garde son sens de contexte explicite du tour. Les agents sans `keepsHistory` conservent le préfixe historique existant. `brain.reset` est transmis à l'agent principal et au délégué. Cela retire les répétitions ajoutées par Floppy, sans supprimer le coût du contexte traité par le fournisseur. Tests avec CLI simulés ; aucune nouvelle mesure de latence ou de facturation sur compte réel. Le mode persistant suit le [protocole streaming Anthropic](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
- **Vérifié** : pas de terminal, pas de fichier lu ou écrit hors du dossier, pas de web, pas d'autre serveur MCP, une écriture refusée n'atteint jamais le serveur de travail. **Le noyau doit vérifier la liste des outils du CLI à chaque démarrage** : une nouvelle version du CLI pourrait en ajouter un.
- **Antigravity** (`agy`, stream-json, plugin `brain-agy-cli`) : pas d'option pour les serveurs MCP, le prompt ou les outils. Le plugin crée un dossier personnel à part (`<données Floppy>/agy-home`, passé en `USERPROFILE`/`HOME`) avec seulement le serveur Floppy, un fichier d'agent (`--agent floppy`) qui porte le prompt et la liste `tools: [view_file]`, et des règles de refus par `--settings`. **Sans cette liste, la recherche web reste active** malgré les règles. Le noyau ne peut pas vérifier la vraie liste d'outils au démarrage : un outil intégré vu dans le flux est noté au journal (`cli.unexpected_tools`). Vérifié le 6 novembre 2026 avec agy 1.5.0 : réponse en ~5 s, pas d'accès au web. Pas de Flash Lite dans le CLI.
- **Émotions des cerveaux CLI** : comme AI SDK, Claude, Codex et Antigravity demandent au modèle de commencer sa réponse par une étiquette (`[content] C'est fait.`). La consigne (`emotionTagPrompt`, FR/EN selon `ctx.assistant.language`) est ajoutée à la fin de leur prompt système (`--system-prompt`, `baseInstructions`, fichier d'agent) ; le texte en flux passe par `EmotionTagFilter`, qui vit dans `@floppy/contracts` (`emotion-tags.ts`, partagé sans qu'un plugin en importe un autre) via `ReplyTags` de `@floppy/agent-cli`. Les événements `text` ne contiennent jamais d'étiquette, les `emotion` sortent dans l'ordre, à leur place ; un nouveau segment (après un outil, un nouvel élément Codex, une nouvelle étape agy) rend l'étiquette de tête possible, et la fin du tour vide le filtre. Le texte final de `done` est sans étiquette. Réglage `emotions` (défaut `true`) par plugin, comme `brain-aisdk` : coupé, ni consigne ni filtre. Les missions d'agent (`scopedAgentRun` : `deleguer_agent`, travaux) et `CompletionService.complete` n'ont jamais la consigne. Quand le CLI est le délégué d'AI SDK, ses événements `emotion` sont relayés au visage (si `emotions` d'AI SDK est actif) ; le mode Live ignore les événements `emotion` d'un délégué. Testé avec des CLI simulés (`packages/agent-cli/test/emotion-contract.ts`) ; aucun essai sur un vrai Claude, Codex ou agy : le respect de la consigne par le modèle n'est pas mesuré.
- **Un élément par CLI, deux modèles** : chaque plugin CLI offre un seul élément (Claude Code, Codex, Antigravity). Sa page règle le modèle du cerveau principal et celui de la délégation (tâches complexes). Le processus de conversation ne tourne que si un slot choisit le CLI.
- **Catalogues dynamiques** : les deux menus sont complétés en arrière-plan depuis le programme installé : Codex `model/list` (toutes les pages, modèles non cachés), Claude `initialize` du protocole de contrôle (`models`), Antigravity `--output-format json models` (`command.data.models`). Aucun prompt ni tour de modèle n'est envoyé. La découverte utilise un processus temporaire, fermé après lecture, avec un délai de 15 s ; elle ne bloque ni `apply` ni les Réglages. Les catalogues sont gardés cinq minutes en mémoire, puis actualisés à la prochaine consultation ; « Actualiser les modèles » force la lecture. Les modèles configurés et les choix enregistrés sont conservés, même s'ils ne sont plus annoncés. En cas d'échec, la dernière liste reste utilisable et un avertissement bilingue invite à réessayer. Luna (`gpt-6-luna`) fait aussi partie des modèles de secours de Codex. La présence dans le catalogue ne garantit pas l'accès au modèle : le programme le vérifie au premier appel.
- On ne modifie jamais la config globale ni les identifiants des CLI de l'utilisateur.

### Sessions d'agent (plugin `agent-sessions`)

« Floppy, demande à Claude d'utiliser Opus pour analyser les bugs des 3 derniers mois et me faire un artefact. » Le cerveau appelle l'outil `ouvrir_session_agent` (agent, consigne, modèle, dossier). Après l'accord (niveau write : « Ouvrir Claude Code (opus) dans un nouveau dossier ? »), Floppy ouvre une **vraie session interactive** du CLI dans un terminal (Windows Terminal, sinon `cmd start` ; Terminal sur macOS ; `x-terminal-emulator` sur Linux), détachée.

- **Pas de bridage ici** : la session a les droits, les serveurs MCP et les connecteurs propres du CLI (artefacts claude.ai compris). C'est le CLI qui demande ses autorisations, dans le terminal. Différent du cerveau et de la délégation, qui restent bridés au MCP Floppy.
- **La consigne ne passe jamais par la ligne de commande** : elle est écrite dans `<home>/sessions/<horodatage>-<agent>.md` ; le CLI reçoit une phrase fixe qui désigne ce fichier. Le nom du modèle est filtré (`[a-z0-9._:-]`), le dossier donné doit exister.
- Sans dossier, chaque session a son sous-dossier dans le réglage « Dossier des sessions » (défaut : l'espace de travail du plugin dans le répertoire de travail de Floppy, `<dossier de Floppy>/workspaces/agent-sessions` ; avant le 7 novembre 2026 : `~/Documents/Floppy`, à remettre dans ce réglage pour retrouver les anciennes sessions).
- Vérifié le 6 novembre 2026 : Claude Code s'ouvre dans Windows Terminal avec `--model haiku` et la phrase entière.

### Mémoire et tâches planifiées dans le montage B

- **Mémoire** : un seul jeu de fichiers. Floppy garde `USER.md` et `MEMORY.md` et génère un `AGENTS.md` à plat dans son dossier de travail. Claude lit `CLAUDE.md` et `AGENTS.md` ; Codex lit `AGENTS.md` mais pas les imports `@fichier`. Seul Floppy écrit la mémoire, par un outil MCP qui passe par l'accord.
- **Tâches planifiées** : Floppy les garde. Les tâches de Claude (`CronCreate`) meurent avec le processus, et Codex n'a pas de planificateur local. Fait : voir [Tâches et Planificateur](taches.md).

### Abonnement ou clé API : conditions d'utilisation

| | Usage personnel | Projet open source installé par d'autres |
|---|---|---|
| Claude (abonnement par le CLI) | zone grise, risque faible | **probablement interdit sans accord écrit d'Anthropic** (pas de connexion claude.ai « pour » un produit tiers) |
| Codex (abonnement par le CLI) | risque faible | zone grise, plutôt toléré si gratuit et local ; OpenAI propose un partenariat « Sign in with ChatGPT » |
| Antigravity (abonnement Google par le CLI) | zone grise | **risqué** : les conditions interdisent l'accès par un logiciel tiers ; réponses contradictoires sur le forum |

Règles :
- **Le mode clé API est proposé partout.** Le mode abonnement est une option « à vos risques », désactivée par défaut.
- Floppy ne lit, ne copie et ne stocke jamais les identifiants des CLI : il lance seulement le CLI officiel, déjà connecté par l'utilisateur.
- Avant de publier le mode abonnement Claude : demander l'avis d'Anthropic.

## Le modèle du cerveau (montage A)

- **Par défaut : Gemma 4 12B Q4_0 + MTP, réflexion coupée**, contexte 32k, Apache-2.0. MTP = petit modèle brouillon qui accélère l'écriture.

```
llama-server --jinja -c 32768 -np 1 -fa on -ctk q8_0 -ctv q8_0 --fit off -ngl 99
  -m gemma-4-12B-it-Q4_0.gguf --spec-type draft-mtp -md mtp-gemma-4-12B-it-Q4_0.gguf -ngld 99
  --reasoning off --host 127.0.0.1 --port 8080
```

- **Option locale : Qwen3.6-35B-A3B** (MoE, experts en RAM avec `--n-cpu-moe 26`, ~13 Go de RAM). Moins juste et plus lent que Gemma dans nos tests ; il invente parfois au lieu d'appeler l'outil.
- **Option cloud : une clé API** (OpenAI, Gemini, Anthropic...), une ligne de config dans l'AI SDK. **Payé à l'usage**, en plus des abonnements.
- **Abonnements (ChatGPT, Claude)** : par les CLI officiels `claude` et `codex`, comme cerveau (montage B) ou pour la délégation (montage A). Voir plus haut.
- Un seul LLM local chargé, partagé par tout le noyau.

## La boucle d'un tour

1. Le texte transcrit arrive au cerveau, avec la mémoire courte (`USER.md`, `MEMORY.md`) et le ton dans un **prompt court, à nous** (~1 500 tokens avec les outils).
2. Un seul appel au LLM, avec **appel d'outils natif**. Pas de modèle de décision devant.
3. Chaque outil passe par l'**accord** du noyau (voir [Sécurité](securite.md)), puis s'exécute.
4. Le LLM rédige la réponse, envoyée en streaming à la voix.

Règles du prompt qui ont fait la différence [M] :

- « N'invente jamais ces informations : appelle toujours l'outil, puis réponds avec son résultat. »
- « Ne demande pas l'accord toi-même : l'application le demande quand il le faut. »

Les outils :

- **Serveurs MCP** choisis par l'utilisateur (Obsidian, Office 365, Azure DevOps, Orca...), lancés par le noyau, hors processus, avec les droits de l'utilisateur.
- **Outils « corps »** déclarés par le corps branché (`afficher_carte`, `ouvrir_reglages`, gestes de Reachy...). Ouvrir une URL est un outil du plugin `browser`, pas d'un corps.
- **Outils internes** : `memoriser`, `chercher_historique`, `lire_skill`.
- **Pas de terminal, pas d'écriture de fichiers, pas d'exécution de code** en v1. Le gros travail passe par Orca (Claude Code, Codex). C'est aussi un gain de sécurité.

## Ce qu'on écrit nous-mêmes (avant : fourni par Hermes)

| Besoin | Comment | Taille estimée [I] |
|---|---|---|
| Mémoire courte | `USER.md` et `MEMORY.md` lus à chaque tour ; outil `memoriser` qui passe par l'accord. Inspiré de Hermes. | petit |
| Historique | SQLite FTS5 avec `node:sqlite` (Node 24), outil `chercher_historique`. | petit |
| Skills | Chargeur de `SKILL.md` + outil `lire_skill`. Une skill n'ajoute aucun droit. | ~50 lignes |
| Tâches planifiées | Fait : registre des tâches dans le noyau + plugin Planificateur ([taches.md](taches.md)). | petit |
| Journal d'audit | Chaque outil, ses paramètres, l'accord, le résultat. | petit |

## Le modèle de décision : retiré de la v1

Testé devant Gemma 4 12B (le petit modèle choisit l'outil, Gemma rédige seulement) [M] :

| Montage | Réponses justes | Premier mot |
|---|---|---|
| Gemma 4 12B seul | 92 % | 0,7 s |
| Gemma 4 E2B en décision | 82 % | 0,4 s |
| LFM3-1.7B en décision | 72 % | 0,9 s |
| LFM3 d1-2B en décision | 45 à 68 % | 0,3 s |
| Recherche par ressemblance (Qwen3-Embedding 0.6B) | 48 % | 0,3 s |

- Aucun ne fait mieux que Gemma seul. Le meilleur gagne 0,3 s, perd 10 points et prend 2 Go de VRAM.
- d1-2B classe des demandes d'outil en « discussion » ; Gemma invente alors la réponse.
- d1-2B et LFM3 sont sous **LFM Open License v1.0** (interdite aux entreprises de 10 M$ de chiffre d'affaires ou plus) : pas compatible avec notre règle de licence.
- Plus tard, si on veut choisir entre local et cloud à chaque demande : mesurer **Gemma 4 E2B** (Apache-2.0) seulement sur cette question, avec un seuil de confiance.

## Budget VRAM (24 Go)

| Poste | VRAM |
|---|---|
| Applis de bureau | ~3,5 à 4,3 Go [M] |
| ASR Parakeet / Qwen3-ASR | ~2 / ~4,5 Go [M] |
| TTS Anna 1.7B / 0.6B / Kokoro | ~4,5 / ~2,5 / ~0,5 Go [M] |
| LLM Gemma 4 12B + MTP, contexte 32k | ~8 Go [M] |

Configuration de base : Parakeet + Anna 1.7B + Gemma 12B ≈ 14,5 Go pour les modèles, ~18,5 Go avec le bureau. À mesurer avec toute la pile voix (prototype 6).

## Prototypes

| N° | Question | Résultat |
|---|---|---|
| 1 | Un plugin peut-il bloquer une écriture MCP jusqu'à l'accord ? | Fait avec Hermes : oui. Leçons gardées : refus par défaut, jeton d'accord jamais visible du modèle. Voir `prototypes\bridge\`. |
| 2 | Vitesse de Hermes | Fait : trop lent pour la voix. Voir `prototypes\latency\`. |
| 3 | Modèles locaux dans Hermes | Fait. Voir `prototypes\local-models\`. |
| 3 bis | Frameworks légers | Fait : AI SDK choisi. Voir `prototypes\frameworks\`. |
| 3 ter | Test de contrôle et modèle de décision | Fait : Gemma 4 12B seul. Voir `prototypes\decision\`. |
| 3 quater | Claude et Codex par leur CLI (abonnement) | Fait : les 2 montages marchent. Claude Haiku 100 % en ~2 s. Voir `prototypes\cli-brain\`. |
| 4 | Demandes ambiguës et délégation | Fait : prompt v3 + phrase d'attente dite par le noyau. Délégation 100 %, questions 100 %, contrôles 92 %. Voir `prototypes\ambiguity\`. |
| 5 | Mode live (Gemini Live) | Fait : slot `conversation.live` ; le noyau libère le LLM et la voix locale en Live. |
| 6 | VRAM avec toute la pile voix | À faire. |
