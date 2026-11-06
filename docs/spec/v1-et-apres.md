# Périmètre de la v1 et après

[← Retour à la spec](README.md)

## Périmètre de la v1

### Contenu

| Bloc | Plugins v1 |
|---|---|
| Noyau | Couche de plugins, config YAML, accords, journal, CLI |
| `voice` | Cascade locale (mot d'activation, VAD, Parakeet ou Qwen3-ASR, TTS Anna). Gemini Live en option. |
| `brain` | Agent Vercel AI SDK dans le noyau. LLM local Gemma 4 12B, réflexion coupée. Modèle cloud par clé API en option. |
| `body` + `display` | App Electron : icône d'état, raccourci clavier, bulle, rendu A2UI, accords. |
| `memory` + `skills` | Dans le noyau : `USER.md`, `MEMORY.md`, historique SQLite FTS5, `SKILL.md` ([Mémoire et skills](memoire-skills-ton-langue.md)). |
| Outils (serveurs MCP et CLI) | Obsidian (recherche et lecture), navigateur (ouvrir une URL), Office 365 (agenda, mails en lecture), Azure DevOps (tickets, PR, builds en lecture), Orca (état des agents, notifications, confier une tâche), Claude Code (questions en lecture seule). |

### Cas d'usage et critères d'acceptation

| Cas d'usage | Critère |
|---|---|
| « Floppy, dans mes notes, comment on déploie le front ? » | Il cherche dans le coffre Obsidian, répond en 1 ou 2 phrases, cite la note. Aucun accès hors du coffre. |
| « Floppy, ouvre le site sur les turn detectors que j'ai noté. » | Il trouve l'URL dans Obsidian et l'ouvre dans le navigateur par défaut. |
| « Floppy, qu'est-ce que j'ai aujourd'hui ? » | Il lit l'agenda Office 365 du jour et le résume. |
| « Floppy, j'ai des PR à relire ? » | Il liste les PR Azure DevOps en attente de l'utilisateur. |
| Un agent Orca finit | L'assistant le dit à voix haute (si important) ou l'affiche, avec un résumé d'une phrase. |
| « Floppy, demande à Claude pourquoi ce test échoue. » | Claude Code tourne en lecture seule, en fond. L'assistant prévient quand la réponse arrive. |
| « Floppy, bascule la voix sur Gemini Live. » | Demande d'accord si le cloud n'est pas autorisé, puis bascule sans redémarrer le noyau. |
| « Floppy, passe en ton sarcastique. » | Les mots, la voix et l'émotion du corps changent tout de suite. |
| Phrase sans « Floppy » hors écoute libre | Ignorée. |
| Le modèle tente d'écrire hors des droits | Refus par le noyau, inscrit au journal. |

### Objectifs de performance

- Première voix : environ 1 s après la fin de la phrase (cascade locale, mesuré sur les prototypes).
- Interruption : la voix s'arrête en moins de 100 ms.
- Demande avec un outil : environ 1 à 1,5 s jusqu'à la réponse complète du cerveau (mesuré : 1,1 s avec Gemma 4 12B et un faux serveur MCP). Avec de vrais serveurs, dire une phrase d'attente si l'outil dépasse ~1 s.
- Mot d'activation : toujours local, faible usage du processeur.


## Après la v1

- Corps Reachy Mini (API HTTP/WebSocket du daemon, son WebRTC à vérifier).
- Corps téléphone, Telegram, WhatsApp (adaptateurs à part).
- Sonos et domotique (niveau `physical`).
- macOS et Linux.
- Détecteur de fin de tour (LiveKit `v1-mini` ou équivalent), transcription en streaming.
- Adaptateur LiveKit si plusieurs corps distants.
- Plugin « labo de voix » (Voice Studio) pour créer ou cloner une voix.
- Consolidation de la mémoire (résumé du soir).
