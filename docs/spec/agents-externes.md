# Agents externes : cerveau, délégation, travaux et sessions

[← Retour à la spec](README.md)

Implémenté le 7 novembre 2026. Les tests emploient des processus et réponses simulés ; aucune nouvelle mesure de latence ni qualification avec les comptes réels des fournisseurs n'a été faite.

## Les plugins offrent les agents

Le contrat `AgentService` vit dans `packages/contracts/src/agents.ts`. Chaque plugin offre `agent` par `ctx.offer`, avec son identifiant, ses alias, sa préparation de session interactive et, s'il le permet, `run` pour une mission pilotée. Il n'y a ni registre global ni modification du noyau.

Les consommateurs déclarent `optional: ["agent"]`, découvrent les offres avec `ctx.offers`, empruntent le profil demandé par `ctx.borrowItem`, puis le rendent. Un identifiant complet `entrée/agent` tranche entre deux profils du même agent ; un nom ambigu est refusé. Les agents désactivés ou dont le programme manque ne sont plus offerts.

`@floppy/agent-cli` partage les déclarations de formulaires, le coffre, le lancement, les profils privés et les lecteurs de protocoles. Les petits plugins dans `plugins/agents/` déclarent leur propre identité et leur protocole ; ils ne s'importent pas entre eux. Les trois plugins historiques offrent également `agent` sans changer leurs slots existants.

| Plugin | Élément | Cerveau / délégation / travail suivi | Session interactive |
|---|---|---|---|
| `brain-claude-cli` | `claude` | oui | oui |
| `brain-codex-cli` | `codex` | oui | oui |
| `brain-agy-cli` | `antigravity` | oui | oui |
| `agent-opencode` | `opencode` | oui, protocole V2 | oui |
| `agent-pi` | `pi` | oui | oui |
| `agent-omp` | `omp` | oui | oui |
| `agent-hermes` | `hermes` | oui, gateway privé supervisé | oui |
| `agent-copilot` | `copilot` | non | oui |
| `agent-cursor` | `cursor` | non | oui |
| `agent-aider` | `aider` | non | oui |

Gemini CLI et Mistral Vibe sont hors périmètre. Les mesures historiques d'Hermes restent dans `cerveau.md` ; elles ne mesurent pas cet adaptateur.

## Réglages et authentification

Ajouter le plugin dans Réglages → Cerveau, ou décommenter son entrée dans `floppy.example.yml` lors de la préparation d'une configuration. Un élément par agent règle le programme, le modèle principal, le modèle de délégation, le fournisseur, le délai et le caractère distant du modèle. Le modèle de délégation vide reprend le modèle principal. Les identifiants `provider/model` et les variantes sont acceptés ; un modèle passé pour une seule mission ne change aucun slot ni réglage.

Les trois adaptateurs historiques Claude Code, Codex et Antigravity complètent leurs deux sélecteurs avec le catalogue de leur CLI, sans appel d'inférence. Le bouton « Actualiser les modèles » relit ce catalogue ; le chargement automatique et le repli sont décrits dans [Le cerveau](cerveau.md#les-adaptateurs-cli-réglages-vérifiés). Les réponses simulées couvrent la découverte, la pagination Codex, les échecs, l'arrêt et l'application du modèle choisi au prochain tour.

Les nouveaux adaptateurs pilotés utilisent un profil privé neuf et un dossier de tour dans l'espace de travail du plugin. Ils ne reprennent pas les connexions OAuth, extensions, réglages ou serveurs MCP des installations personnelles. Une clé facultative est gardée par `itemSecret` dans le coffre, puis passée uniquement dans l'environnement du processus. La variable est déduite du fournisseur (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) ou précisée dans le formulaire. L'authentification et la disponibilité du modèle sont confirmées au premier appel.

Les configurations générées référencent le jeton MCP par variable d'environnement ; elles ne contiennent ni clé API ni jeton en clair. Les profils temporaires sont retirés à la fin du tour. Les modèles principal et délégué gardent séparément les douze derniers messages de chaque conversation ; `reset` les oublie.

## Exécution pilotée

Le cerveau principal choisit l'offre `llm` dans `brain.main`, la délégation habituelle choisit `delegate` dans `brain.delegate`. Chaque demande lance un processus dans le fork qui l'emprunte. Le texte arrive sur stdin ou par le protocole WS, pas par une commande de shell. Les shims npm reconnus sont traduits en programme Node + script ; un autre script de shell est refusé.

Chaque tour reçoit un jeton MCP limité aux outils visibles. `delegate_to_agent`, `start_agent_job` et `open_agent_session` sont retirés de ce périmètre pour empêcher une mission de lancer d'autres missions ou un terminal. Un appel d'outil métier passe toujours par le serveur MCP et l'accord du noyau. Les résultats de processus en erreur, flux invalides, outils inconnus et résultats manquants sont refusés. Annulation et délai ferment les processus et révoquent le jeton.

- **OpenCode V2** : serveur privé `--standalone`, configuration et répertoires de données séparés, agent `floppy` dont les permissions refusent tout sauf les outils MCP déclarés. Une configuration système ou administrée détectée fait refuser ce mode ; elle pourrait sinon charger du code avant nos règles. Le service partagé de l'utilisateur n'est pas utilisé.
- **Pi** : mode print JSON, extension MCP intégrée seule, liste `mcp__floppy__*`, sans outils natifs, ressources projet, skills ni contexte ambiant.
- **Oh My Pi** : lecteur JSON distinct, outils natifs coupés, extensions et règles coupées, MCP projet désactivé, mémoire et apprentissage désactivés, attente de la connexion MCP obligatoire. Le seul serveur découvert dans son profil est Floppy. Ses noms d'outils diffèrent de Pi.
- **Hermes** : Floppy lance le propriétaire du gateway en premier plan (`--no-supervise --external-supervisor`), dans son propre `HERMES_HOME`, puis découvre son endpoint sans autoriser son démarrage automatique. Il vérifie le chemin du profil et l'adresse locale, se connecte directement en WS avec le ticket éphémère et vérifie les capacités annoncées. Chaque session reçoit seulement le toolset `floppy`. Ni `chat` ni ACP ne servent de client piloté : ils pourraient démarrer un gateway détaché. Les événements sont filtrés par session et admission, y compris ceux reçus avant l'accusé de réception. Seul un règlement final `completed/complete` est un succès. Déconnexion, trou de rejeu et demande interactive inattendue échouent ; le gateway privé est arrêté avec son arbre de processus.

## Missions nommées et travaux suivis

Le plugin `agent-jobs` apporte cinq outils, sans nouveau mécanisme de tâche dans le noyau :

| Outil | Niveau | Comportement |
|---|---|---|
| `list_agents` | read | Identifiants, alias, session interactive et disponibilité de l'exécution pilotée |
| `delegate_to_agent` | write | Mission ponctuelle avec agent et modèle nommés, résultat dans le tour courant |
| `start_agent_job` | write | Rend immédiatement l'identifiant du travail ; le résultat arrive plus tard |
| `list_agent_jobs` | read | Liste des états ou résultat complet d'un identifiant |
| `stop_agent_job` | write | Demande d'arrêt d'une mission en cours |

Trois travaux simultanés au plus par défaut ; délai global de dix minutes, auquel s'ajoute le délai propre de l'adaptateur (deux minutes par défaut pour les nouveaux agents). La mission conserve l'origine du corps pour router ses accords. Le changement de modèle reste ponctuel.

L'historique atomique `workspaces/agent-jobs/jobs.json` garde cent travaux et leurs résultats (200 000 caractères au plus). Si `documents` est disponible, une réussite produit aussi un document. Une initiative annonce la fin ou l'échec ; le résultat reste consultable. Au redémarrage, une mission restée `running` devient `interrupted` et n'est jamais rejouée automatiquement. Arrêter le plugin annule ses missions et rend ses emprunts.

## Sessions interactives

`agent-sessions` découvre les mêmes offres, sans liste fermée de nouveaux agents. Les anciens réglages `claudeExe`, `codexExe`, `agyExe` sont conservés pour compatibilité ; un élément configuré mais désactivé ne peut pas être contourné par ce chemin.

La consigne est écrite atomiquement dans un fichier à identifiant unique ; une phrase fixe désigne ce fichier au CLI. Les dossiers de nouvelles sessions sont également uniques. Les agents interactifs utilisent leur installation, leurs connexions et leurs accords propres et restent ouverts après Floppy (`keep: true`). Aider reçoit un fichier de commandes `--load` contenant `/code` et la phrase fixe : il traite la demande puis reste interactif.

## Sources des protocoles

- [OpenCode : CLI](https://opencode.ai/docs/cli/), [permissions](https://opencode.ai/docs/permissions/), [découverte des configurations système](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/discovery.ts).
- [Pi : CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md), [MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).
- [Oh My Pi : MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md), [mode print](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/print-mode.ts).
- [Hermes : sessions locales](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions), [règlement final](https://github.com/NousResearch/hermes-agent/blob/main/gateway/session_settlement_recovery.py), [client gateway](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/gateway_client.py).
- [Copilot : CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [Cursor : CLI](https://cursor.com/docs/cli/overview), [Aider : options](https://aider.chat/docs/config/options).
