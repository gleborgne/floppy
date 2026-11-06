# Intégration avec Hermes Agent

[← Retour à la spec](README.md)

> **Abandonné le 4 novembre 2026.** Hermes était trop lent et trop lourd pour la voix (prototypes 2 et 3). Le cerveau est maintenant un agent Vercel AI SDK dans le noyau : voir [Le cerveau](cerveau.md). Cette page est gardée pour l'historique et pour ses leçons (sécurité, abonnements). Hermes a été désinstallé du PC de test le même jour.

Décision initiale du 4 novembre 2026 : **le cerveau et les mains reposent sur Hermes Agent** (Nous Research). On ne recode pas ce qui existe déjà et qui est maintenu par une grande communauté. L'assistant apporte ce que Hermes n'a pas : la voix rapide, le corps, l'affichage, le modèle de décision et l'accord strict.

Légende : **[V]** vérifié dans la doc ou le code de Hermes. **[I]** déduction, à vérifier par un prototype.

## Pourquoi Hermes

- Licence MIT, très actif, grande communauté. Tourne nativement sous Windows [V].
- Déjà fourni [V] : boucle d'agent, client MCP, outils, plugins Python avec hooks, skills `SKILL.md`, mémoire, tâches planifiées (cron), messageries (Telegram, WhatsApp...), API locale.
- En mode local, il lance les serveurs MCP et les CLI **avec les droits de l'utilisateur** (MCP Azure DevOps, MCP Office 365, Orca...) [V].
- Fournisseurs de modèles : serveur local compatible OpenAI (llama.cpp), Anthropic, Gemini, Codex [V].

## Partage des rôles

| Rôle | Qui le fait |
|---|---|
| Mot d'activation, voix (cascade locale, mode live), interruptions | **L'assistant** |
| Corps et affichage (bulle Electron, A2UI, Reachy plus tard) | **L'assistant** |
| Modèle de décision (intention, simple ou complexe, local ou cloud) | **L'assistant**, avant Hermes |
| Réponses simples sans outil | **L'assistant** (LLM local partagé), sans passer par Hermes |
| Accord : afficher la demande, recevoir le « oui » | **L'assistant** |
| Raisonner, choisir et appeler les outils | **Hermes** |
| Mains : MCP, CLI, Orca, Claude Code | **Hermes** |
| Mémoire, skills, tâches planifiées | **Hermes** |
| Messageries (Telegram, WhatsApp) | **Hermes** (gateway) |

Hermes reste derrière l'interface `brain` de l'assistant : on peut le remplacer plus tard.

**Règle : l'assistant ne modifie pas le fonctionnement normal de Hermes.** L'utilisateur garde son usage habituel de Hermes (terminal, autres clients de l'API) avec tous les outils. En particulier, on ne réduit pas les outils de la plateforme `api_server` : ce réglage est global à tous les clients de l'API, et on ne peut pas choisir les outils par requête. La vitesse se gagne ailleurs : cache de prompt réchauffé, questions simples sans Hermes, réponse d'attente parlée. Seulement si un problème est **mesuré**, on envisagera un profil Hermes séparé pour l'assistant (mémoire alors séparée). Les ajouts autorisés : le plugin « bridge » et la déclaration des serveurs MCP.

## Câblage

```
Vous ──voix──► ASSISTANT (TypeScript + services Python)
                 │ mot d'activation → voix → décision (LFM3 d1-2B)
                 │
                 ├─ simple, sans outil ─────────► LLM local (réponse directe)
                 │
                 └─ avec outils ──► HERMES (API locale 127.0.0.1:8642, clé)
                                     │  route "rapide"  → LLM local (Gemma / Qwen)
                                     │  route "profond" → modèle plus fort
                                     │
                                     ├─ MCP Azure DevOps, Office 365, Obsidian... (droits de l'utilisateur)
                                     └─ Orca → agents Claude Code / Codex (abonnement)

        plugin Hermes « bridge » (Python)
          · pre_tool_call : demande l'accord à l'assistant, bloque jusqu'à la réponse
          · événements : progression des outils, fin des tâches, alertes cron → assistant
```

### L'API de Hermes

- L'assistant appelle l'**API locale** de Hermes : `/v1/responses`, l'**API Runs** (événements SSE de progression des outils et des sous-agents) et l'API Sessions [V].
- Écoute sur `127.0.0.1:8642`, avec une clé [V].
- **Routes par modèle** (`platforms.api_server.extra.model_routes`) : l'assistant envoie un nom de route (`rapide`, `profond`) choisi par le modèle de décision ; Hermes l'envoie vers le bon modèle [V]. À vérifier avec des modèles locaux [I].
- Les événements de progression servent au corps et à l'affichage (« je cherche dans vos PR... »).

### Le plugin « bridge » dans Hermes

Un plugin Python à nous, installé dans Hermes :

- **Accord** : dans le hook `pre_tool_call`, pour tout outil qui écrit, envoie ou supprime, il demande l'accord à l'assistant et **bloque** jusqu'à la réponse (pas de réponse = refus). L'accord reste tenu par l'interface, jamais par le modèle.
- **Journal d'audit** : il écrit chaque appel d'outil et sa décision.
- **Initiatives** : il transmet à l'assistant les fins de tâches, les alertes cron et les messages d'Orca.

À prouver par un prototype : que ce hook **bloque vraiment** les écritures MCP [I].

## Modèles et abonnements

| Fournisseur | Dans Hermes | Coût |
|---|---|---|
| LLM local (llama.cpp : Gemma, Qwen) | fournisseur `custom` / `llamacpp` [V] | gratuit |
| Codex / ChatGPT | connexion à l'abonnement (`hermes auth add openai-codex`) [V] | abonnement |
| Claude | OAuth seulement avec Max **et** crédits « extra usage » [V] | paiement à l'usage |
| Gemini | clé API seulement [V] | paiement à l'usage |
| **CLI officiels** (`claude`, `codex`) lancés par Hermes ou par Orca | outils | **abonnement** (connexion propre au CLI) |

Choix par défaut : **orchestration en local** (Gemma ou Qwen), **gros travail via Orca → Claude Code / Codex** (abonnement).

## Budget VRAM (24 Go)

Hermes ne prend pas de VRAM : ce sont les modèles. Règle : **un seul LLM chargé**, partagé par l'assistant et Hermes (un seul llama-server).

| Poste | VRAM |
|---|---|
| Applis de bureau | ~3,5 à 4,3 Go (mesuré) |
| ASR Parakeet / Qwen3-ASR | ~2 / ~4,5 Go (mesuré) |
| TTS Anna 1.7B / 0.6B / Kokoro | ~4,5 / ~2,5 / ~0,5 Go (mesuré) |
| LLM Gemma 4 12B Q4 + MTP, contexte 8k | ~8 Go (mesuré) |
| LLM Gemma 4 12B Q4 + MTP, **contexte 64k (minimum exigé par Hermes)** | **~9 Go** (mesuré) |
| Décision d1-2B quantifié | ~1,5 à 2 Go (estimé) |

Configurations à tester :

- **A, équilibrée** : Parakeet + Anna 1.7B + Gemma 12B (contexte 64k, ~9 Go mesuré) + d1-2B ≈ 17,5 à 18 Go sur ~20 Go disponibles.
- **B, meilleure compréhension** : Qwen3-ASR, avec Anna 0.6B ou Kokoro.
- **C, cerveau plus fort** : modèle MoE (type Qwen3-30B-A3B) avec les experts en RAM (`--n-cpu-moe`), ~4 à 6 Go en VRAM (estimé), plus lent.

Astuces : contexte compressé (`-ctk q8_0 -ctv q8_0`), un seul slot (`-np 1`), ASR ou TTS sur le processeur (ou plus tard le NPU), fermer LM Studio.

## Installation et sécurité de Hermes

- Installer avec le script PowerShell officiel, **lu avant d'être lancé**. Fichiers dans `%LOCALAPPDATA%\hermes` [V].
- Au premier lancement, **refuser l'import** depuis Claude Code, Codex ou Cursor.
- Réglages de base (`hermes config edit`) [V] :

```yaml
approvals:
  mode: manual
  cron_mode: deny
  unattended_mode: deny
  deny: ["git push --force*", "Remove-Item * -Recurse*", "az * delete*"]
terminal:
  backend: docker
  docker_forward_env: []
security:
  allow_private_urls: false
  allow_lazy_installs: false
auth:
  adopt_external_logins: false
plugins:
  enabled: []        # puis seulement le plugin « bridge », relu
```

- Chaque serveur MCP est déclaré `trust: untrusted`. Secrets seulement dans `mcp_servers.<nom>.env` ou le `.env` de Hermes.
- Jamais `--yolo`, `/yolo` ni `approvals.mode: off` (ils sautent les accords MCP).
- Mises à jour à la main (`hermes update`), et **version figée** : Hermes change presque tous les jours.

Limites connues [V] : pas de manifeste de droits par plugin ; les chemins protégés ne sont pas un vrai sandbox ; avec `docker`, la vérification des commandes dangereuses est laissée au conteneur.

## Prototypes avant de construire

1. **Accord** : le hook `pre_tool_call` du plugin « bridge » bloque-t-il vraiment une écriture MCP jusqu'à l'accord de l'interface ?
   **Fait le 4/11/2026 : oui** (6 tests sur 6, voir `prototypes\bridge\README.md`). Leçons : le gateway de Hermes charge les plugins seulement à son démarrage (l'assistant doit le démarrer lui-même et vérifier que le bridge est chargé) ; outils MCP nommés `mcp__<serveur>__<outil>`. Contournements **forcés** (faux LLM qui impose des appels piégés) : **aucun n'a marché** — jeton absent du conteneur, écritures de fichiers confinées au conteneur, `.env` refusé, adresses privées bloquées pour le web, skills en lecture seule, appel MCP via `tool_call` bloqué par le bridge. Point d'attention : l'interface d'accord est **joignable** depuis le conteneur (`host.docker.internal`) ; seul le jeton protège. Le bridge ne contrôle que les outils MCP ; les outils intégrés reposent sur Docker et `approvals.mode: manual`.
2. **Vitesse** : combien de temps ajoute le passage par l'API Runs de Hermes ?
   **Fait le 4/11/2026** (voir `prototypes\latency\README.md`). Question simple : Hermes + LLM local 0,6 à 1,9 s avec le cache de prompt chaud (8,7 s à froid) ; Hermes + Codex ~2,5 s. Avec un outil : 4 à 7 s en local, ~8 s avec Codex. **Hermes exige un contexte de 64k tokens** (~9 Go de VRAM pour Gemma 12B). Conséquences : questions simples sans Hermes ; réponse d'attente parlée et progression affichée pour les outils ; cache réchauffé au démarrage ; outils inutiles de Hermes désactivés.
3. **Modèles locaux** : Gemma 4 12B et un Qwen dans Hermes, sur 15 à 20 demandes réalistes (bon outil, bons paramètres, temps, VRAM).
   **Fait le 4/11/2026** (voir `prototypes\local-models\README.md`). 20 demandes, 1 passage par modèle. **Qwen3.6-35B-A3B (MoE, experts en RAM, réflexion coupée) : 80 % juste**, 9,6 Go de VRAM, ~13 Go de RAM, 15 s à froid (réchauffer le cache). Gemma 4 12B et Qwen3.5-9B : 70 %. Codex : 95 %. Bonsai-27B et LFM2.5-24B : inutilisables. Qwen3.8-27B : arrêté, trop lent (3,7 mots/s). Points ouverts : la skill `obsidian` de Hermes envoie les modèles locaux chercher les notes dans le conteneur au lieu du MCP ; les tâches annexes de Hermes (titres de session) occupent le seul slot du LLM 5 à 15 s après chaque réponse. Strata mis de côté.
4. **Routes** : `model_routes` avec des modèles locaux (llama.cpp).
5. **Décision** : LFM3 d1-2B sur des phrases en français (intention, simple ou complexe).
6. **VRAM** : configurations A et C avec un vrai contexte Hermes (VRAM maximale, mots par seconde, première voix).
