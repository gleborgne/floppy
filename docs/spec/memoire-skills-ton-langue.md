# Mémoire, skills, ton et langue

[← Retour à la spec](README.md)

## Mémoire et skills

### Mémoire

La mémoire est **écrite dans le noyau, sur le modèle de Hermes** (Markdown lisible, index de recherche, relecture par l'utilisateur).

- **2 petits fichiers Markdown toujours dans le prompt** : `USER.md` (profil de l'utilisateur, ~1 400 caractères) et `MEMORY.md` (notes de l'assistant, ~2 200 caractères). Quand un fichier est plein, l'écriture échoue et le modèle doit résumer ou supprimer.
- **Historique des conversations** dans SQLite avec FTS5 (`node:sqlite`, intégré à Node 24), consulté avec l'outil `chercher_historique`, jamais injecté d'office.
- **Photo figée** de la mémoire au début de chaque conversation (le début du prompt reste stable, donc le cache du LLM reste chaud).
- **Remplissage** : outil `memoriser` pendant le tour, et sur demande (« Souviens-toi que... », « Oublie ça »). Plus tard : relecture après plusieurs tours, et résumé du soir.
- **Relecture par l'utilisateur** : chaque écriture passe par l'accord (niveau `write`). Une écriture est refusée si la note a changé entre-temps.
- Les écritures sont contrôlées contre l'injection et la fuite de données.

### Skills

- Une skill = un fichier `SKILL.md` (format agentskills.io) : quand l'utiliser, les étapes, les outils à appeler.
- Le prompt contient seulement le nom et la description courte de chaque skill. L'outil `lire_skill` charge le texte quand il sert.
- L'assistant peut proposer une nouvelle skill ou une correction. Elle attend l'accord de l'utilisateur.
- Une skill **n'ajoute aucun droit** : elle utilise les outils déjà autorisés.
- Leçon de Hermes : une skill mal écrite peut détourner un petit modèle (la skill `obsidian` de Hermes envoyait les modèles locaux au mauvais endroit). Tester chaque skill avec le modèle local.

### Ton

- Préréglages (cordial, sarcastique, sobre...) et texte libre.
- Le ton change :
  - **les mots** : consigne de style dans le prompt du cerveau ;
  - **la voix** : consigne de ton pour le TTS, ou choix de voix ;
  - **le corps** : émotions affichées.
- Le ton ne change pas le comportement (initiatives, accords).


## Langue et nom

- La langue est un paramètre partout : prompts, reconnaissance, voix, mot d'activation, textes de l'interface.
- La v1 est réglée et testée en français. Les autres langues dépendent des modèles choisis.
- Le nom de l'assistant et le mot d'activation sont configurables. « Floppy » est un réglage, pas le nom du projet.
