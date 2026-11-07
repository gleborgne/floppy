# Agents CLI : Pi, Oh My Pi et Hermes

Recherche du 7 novembre 2026 pour le plan d'intégration. Sources primaires consultées ; aucune installation ni mesure locale. Les interfaces de la version effectivement installée devront être vérifiées. Cette note propose des pistes ; elle ne change pas les décisions de la spec.

## Pi

Le dépôt historique `badlogic/pi-mono` redirige aujourd'hui vers `earendil-works/pi`. Le projet documente une interface interactive, les modes print/JSON, un RPC de processus et un SDK TypeScript. Le README annonce la prise en charge de Windows et une licence MIT. [README officiel](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

`pi --mode rpc --no-session` démarre un processus persistant parlant JSONL sur stdin/stdout. Les commandes sont corrélées par identifiant ; les réponses d'admission ne signalent pas la fin du travail. La documentation demande d'attendre `agent_settled`, de consommer stdout continuellement et de borner les attentes côté hôte. [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

La version documentée possède désormais un client MCP natif, en stdio ou HTTP Streamable. Les serveurs se configurent dans les fichiers utilisateur et projet ; des en-têtes HTTP peuvent référencer une variable d'environnement. [MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).

`--no-builtin-tools` désactive les outils intégrés ; `--no-tools` désactive aussi les autres catégories. `--tools` peut filtrer les outils MCP avec des motifs commençant par `mcp__`. `--no-extensions -e builtin:mcp` conserve uniquement l'extension MCP intégrée ; `--no-skills`, `--no-context-files` et `--no-prompt-templates` réduisent les ressources ambiantes. La sélection exacte devra être testée avec la version installée. [CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md).

**Déduction pour Floppy :** bon candidat cerveau/délégué via RPC et MCP, sous réserve de vérifier le profil isolé et les outils réellement exposés. Un lancement interactif peut conserver les outils propres de Pi. Sa documentation rappelle que le processus et ses extensions disposent des droits de l'utilisateur : le filtrage des outils n'est pas un bac à sable système. [Sécurité](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

## Oh My Pi (`omp`)

Fork distinct de Pi, doté de nombreux outils de développement et d'une installation Windows. Le README avertit que `--no-tools` désactive les outils intégrés mais laisse les modules d'outils projet comme surface distincte. Il documente une découverte de configurations d'autres agents, ainsi que `--no-extensions` et une liste exacte d'extensions autorisées. [README](https://github.com/can1357/oh-my-pi).

`omp --mode rpc` parle un protocole JSONL propre, différent de JSON-RPC 2.0. Un message initial `ready` annonce les versions et limites ; les gros messages peuvent nécessiter le transport v2. Le protocole expose aussi des outils fournis par l'hôte : `set_host_tools`, `host_tool_call`, `host_tool_result`. Cela permettrait à Floppy d'exécuter ces appels par son propre chemin d'accord, sans ajouter un serveur MCP pour ce transport. [RPC et outils hôte](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

**Déduction pour Floppy :** priorité aux sessions de travail autonomes ; cerveau/délégué possibles après validation de l'isolation des réglages, extensions, modules projet et outils. Ne pas supposer que le client RPC de Pi est compatible avec celui d'OMP.

## Hermes Agent

Le CLI actuel documente `hermes chat --query-file - --format stream-json` pour recevoir une demande sur stdin et émettre progression et résultat JSONL. Le terminal `result` contient le résultat complet et le code de sortie. `--toolsets` sélectionne les familles d'outils ; `--ignore-user-config` et `--ignore-rules` réduisent les entrées ambiantes. `--safe-mode` coupe également MCP : il ne suffit donc pas pour garder les outils Floppy. Un serveur ACP stdio existe aussi. [CLI](https://hermes-agent.nousresearch.com/docs/reference/cli-commands).

Hermes peut consommer des serveurs MCP externes configurés dans `config.yaml`. [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

**Déduction pour Floppy :** commencer par une session autonome ou une tâche longue suivie ; évaluer ensuite le profil MCP limité. Les anciennes mesures du dépôt avaient écarté Hermes pour la voix : cela ne démontre ni la latence de la version actuelle ni son adéquation aux tâches longues. Refaire le benchmark avant de proposer Hermes comme cerveau vocal par défaut.

## Critères communs avant activation

- Vérifier exécutable, version, authentification et disponibilité du modèle sans copier les identifiants du CLI.
- Tester un profil contrôlé ne présentant que les outils Floppy, y compris face aux configurations et extensions utilisateur/projet.
- Tester annulation, délai maximal, arrêt du processus, erreur d'authentification, flux incomplet et reprise de session.
- Distinguer explicitement cerveau/délégation sous accords Floppy et session interactive avec outils et accords propres à l'agent.

## Ordre proposé pour le catalogue

Priorités de produit, sans prétendre mesurer la popularité des outils. Les sources des autres candidats ont été vérifiées séparément lors de la préparation du plan.

| Lot | Agents | Première cible proposée |
|---|---|---|
| P1 | [OpenCode](https://opencode.ai/docs/cli/), Pi, Oh My Pi, Hermes | Couvrir les quatre ajouts demandés ; qualifier séparément chaque usage |
| P2 | [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) | Élargir aux utilisateurs Copilot |
| P3 | [Cursor CLI](https://cursor.com/docs/cli/overview), [Aider](https://aider.chat/docs/scripting.html) | Sessions et tâches de développement, après qualification des contraintes |

OpenCode documente un service partagé et un mode `--standalone` : tester explicitement l'isolation selon la version installée. Les formats JSON/JSONL disponibles chez plusieurs candidats facilitent le suivi mais ne prouvent pas à eux seuls le contrôle des outils ou des permissions.

Périmètre corrigé à la demande de l'utilisateur : Gemini CLI et Mistral Vibe exclus. La réalisation et ses limites sont décrites dans [Agents externes](../spec/agents-externes.md). Pour Hermes piloté, elle emploie le protocole WS direct et un gateway privé supervisé ; le CLI `chat` décrit plus haut reste réservé aux sessions interactives.
