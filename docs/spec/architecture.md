# Architecture

[← Retour à la spec](README.md)

Le cerveau est un **plugin** : agent **Vercel AI SDK** avec un LLM local, ou CLI Claude / Codex (voir [Le cerveau](cerveau.md#deux-montages-un-seul-noyau)). Le noyau gère la voix, le corps, l'affichage, les outils, la mémoire et l'accord. Il expose ses outils par un **serveur MCP « Floppy »** local, utilisé par tous les cerveaux.

```
┌──────────────────────── NOYAU DE L'ASSISTANT (TypeScript, Node 24) ───────────────┐
│  Registre de plugins · Bus d'événements · Accords · Config · CLI · Journal         │
│  Services :  voice   brain (AI SDK)   tools (MCP)   memory   skills   body   display│
└──────┬─────────────────┬────────────────────┬─────────────────────┬───────────────┘
       │                 │                    │                     │
  Programmes        Serveurs MCP et CLI  Corps (body)         Fournisseurs live
  natifs (LLM,      hors processus       Electron (v1)        (Gemini Live,
  voix) : llama-    (Obsidian, O365,     Reachy (plus tard)   GPT Live)
  server, audio.cpp Azure DevOps, Orca)
```

## Les services

| Service | Rôle | Fournisseurs prévus |
|---|---|---|
| `brain` | Comprendre, choisir les outils, répondre en texte ; traiter les délégations GPT Live. | **Agent AI SDK**, **CLI Claude**, modèle cloud par clé API |
| `voice` | Écoute locale (VAD, ASR, activation) et synthèse locale de la cascade. | Cascade locale |
| `tts` | Synthèse indépendante : texte vers flux PCM, annulable. | Gemini TTS, ElevenLabs TTS ; absent : synthèse locale de `voice` |
| `live` | Session audio native : audio, transcriptions, fonctions ou délégation client. | Gemini Live, GPT Live |
| `wakeword` | Détecteur local par corps : audio ou transcriptions existantes vers une activation. | STT (par défaut), Sherpa ONNX, Porcupine ; absent : bouton uniquement |
| `body` | Montrer l'état et les émotions, donner du retour. | Electron (v1), Reachy, téléphone, Telegram |
| `display` | Afficher les réponses et l'UI générée. | Bulle Electron (A2UI, MCP Apps) |
| `memory` | Retenir et retrouver faits, préférences, leçons. | **Noyau** (`MEMORY.md`, `USER.md`, historique en SQLite FTS5 avec `node:sqlite`) |
| `skills` | Fournir des recettes Markdown à la demande. | **Noyau** (`SKILL.md`, outil `lire_skill`) |
| `tools` | Agir : lire, chercher, ouvrir, envoyer. | Serveurs **MCP** (client MCP de l'AI SDK) : Obsidian, Office 365, Azure DevOps, Orca ; CLI Claude Code / Codex par Orca ; outils « corps » (afficher une carte, ouvrir les réglages) ; plugin `browser` (ouvrir une URL) |

## Les modes du cerveau

Un plugin Live fournit le service **`live`**, distinct des contrats texte `brain` et cascade `voice`.
`conversation/default` compose ces services et possède l'activation, le routage, les accords et la politique de fermeture.
Le slot `conversation.live` choisit le mode : « Séparé » (aucun) ou un moteur Live (Gemini Live, GPT Live). Le slot `voice.tts` choisit la voix du mode Séparé (moteur et voix ensemble : voix locale Qwen3-TTS ou Kokoro, ElevenLabs, Gemini TTS). Le slot `brain.main` choisit le modèle du cerveau, `brain.delegate` le délégué.
Le noyau fait tourner seulement ce que le mode demande : en Live, ni le cerveau local, ni llama-server, ni le modèle TTS local ne tournent (voir [noyau.md](noyau.md#cycle-de-vie), règles 10 à 13). GPT Live demande le cerveau pour la délégation : il tourne alors.
`service.wakeword` choisit une seule instance de détecteur, indépendamment du mode de conversation. Les paramètres et modèles appartiennent à son plugin. Chaque détecteur fournit une fenêtre audio avec pré-roll ; la conversation garde la décision d'ouvrir Live, l'écoute libre et la mise en veille. Un changement de fournisseur ferme les détecteurs et sessions dépendants ; un changement de paramètres recrée les détecteurs. Le bouton parler contourne la détection.
Les choix cloud sont soumis à l'accord à la voix et conservés par les réglages du noyau. Aucun import entre plugins.

| | Mode séparé | Mode live |
|---|---|---|
| Qui écoute et parle | écoute locale ; synthèse locale ou service `tts` | activation locale, puis voix native du modèle Live |
| Qui décide et choisit les outils | notre `brain` (Gemma, Claude...) | fonctions Gemini via le noyau ; délégation GPT Live vers `brain` |
| Point fort | même comportement quelle que soit la voix ; peut rester 100 % local | conversation la plus fluide et la plus naturelle |
| Point faible | un peu moins fluide | dépend du cloud ; comportement propre au modèle live |

Règles communes aux 2 modes :

- **Les outils passent toujours par le noyau et par l'accord.** En mode live, le modèle live reçoit les mêmes outils (MCP, corps, internes) ; ses appels reviennent au noyau, qui les contrôle et les exécute.
- **La mémoire et le ton** sont fournis par l'orchestrateur : mémoire à l'ouverture et après les outils qui la modifient, ton mis à jour pendant la session. La liste d'outils natifs est figée pour une session et renouvelée à l'ouverture suivante. Le chargement des skills reste une évolution distincte.
- **Délégation** : GPT Live utilise la délégation client ; `conversation` reconstruit le contexte transcrit et appelle `brain.run`, puis renvoie le résultat au modèle Live. Les fonctions Gemini passent directement par `ctx.tools.call`.
- **Mot d'activation local** : en mode live, le son part vers le cloud seulement après le mot d'activation, et la session se ferme après l'écoute libre.

## La couche de plugins

Inspirée de Cordis (voir [l'audit, section 1](../audit-liens.md#1-cordis-et-deepseek-harness)) :

- **Plugin** : un module avec un manifeste et une fonction `apply(ctx, config)`.
- **Service** : un nom sur le contexte (`ctx.voice`, `ctx.brain`). Un service peut avoir plusieurs fournisseurs ; la config choisit le fournisseur actif.
- **Contrats par domaine** : les contrats de service (`llm`, `brain`, `delegate`, `memory`, `voice`, `tts`, `live`, `coder`, `mcp`, `body`, `avatars`…) sont dans `packages/contracts` (un fichier par domaine, `avatars.ts` pour `defineAvatar`) ; le noyau ne garde que `task` et `documents`. Un plugin ne parle aux autres que par eux et **n'importe jamais un autre plugin** (test `packages/core/test/boundaries.test.ts`). Voir [Le noyau](noyau.md#les-services-contrats).
- **Dépendances** : un plugin déclare les services qu'il attend. Si un fournisseur change, ses dépendants redémarrent sur le nouveau.
- **Effets** : tout ce qu'un plugin ouvre (WebSocket, processus, micro) est enregistré avec sa fonction de fermeture. Décharger un plugin nettoie tout.
- **Hooks en cascade** : middlewares avec `next()`, utilisés surtout avant chaque outil.
- **Config** : un arbre YAML d'entrées `{id, plugin, config, disabled}`, validé par schéma. Un changement remonte seulement ce qui a changé.
- **Erreur visible** : un plugin bloqué parce qu'un service manque est signalé (icône, CLI), jamais en silence.

## Le manifeste de plugin

Chaque plugin déclare :

- `id`, `version`, `description`, `licence`.
- `provides` : les services qu'il fournit. `inject` : les services qu'il attend.
- `runtime` : `in-process` (plugins du noyau seulement) ou `out-of-process` (processus enfant). Les « mains » sont des serveurs MCP ou des CLI, toujours hors processus.
- `permissions` : ce qu'il veut toucher. Exemples : `fs.read: ["<coffre Obsidian>"]`, `net: ["graph.microsoft.com"]`, `exec: ["orca"]`, `cloud: true`, `approvals: "respond"` (répondre aux accords : corps et conversation seulement). Aujourd'hui, `exec` (par `ctx.spawn`) et `approvals` sont **imposés** par le noyau ; les autres sont déclaratifs. Le manifeste est validé par un schéma zod. Voir [Sécurité](securite.md#garde-fous-du-code).
- `sections`, `addable` : rubriques de la fenêtre des réglages apportées par le plugin, et plugin « application » que l'utilisateur ajoute ou retire (voir [Éléments](elements.md)).
- `tools` : pour chaque outil, le schéma d'entrée, le **niveau** (`read`, `write`, `send`, `delete`, `physical`), et des métadonnées (non bloquant, quand le lancer, description courte pour les petits modèles).

## Le protocole entre le noyau et les corps

- WebSocket local, sur `127.0.0.1` seulement par défaut.
- Messages inspirés d'OpenAI Realtime et des concepts de LiveKit, pour pouvoir ajouter un adaptateur LiveKit plus tard.
- Au branchement, le corps déclare ses **outils « corps »** (exemples : `afficher_carte`, `ouvrir_reglages`, `hocher_tete`). Son **identité** (id, nom) vient du transport, jamais du `hello`. Le noyau les ajoute aux outils du cerveau et renvoie leurs appels au corps.
- Le noyau envoie des **événements** : état (veille, écoute, réfléchit, parle), émotion, notification, UI A2UI, demande d'accord.
- Le corps renvoie les **réponses d'accord** (voir [Sécurité → L'accord](securite.md#laccord)).

## Les modèles locaux

- Chaque modèle local tourne dans un programme natif piloté par le noyau (llama-server pour le LLM, audio.cpp pour la voix), ou dans le noyau (sherpa-onnx pour l'écoute). Le service Python est retiré depuis le 6 novembre 2026 (voir [Écoute](ecoute.md)).
- **Un seul LLM local** (un seul llama-server), utilisé par le cerveau. Voir le budget VRAM dans [Le cerveau](cerveau.md#budget-vram-24-go).
- Le noyau démarre, surveille et arrête ces programmes (effets). Il note ceux qu'il lance (`children.json`) et arrête au démarrage suivant ceux restés d'un arrêt forcé.
