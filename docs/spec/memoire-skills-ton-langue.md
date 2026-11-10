# Mémoire, skills, ton et langue

[← Retour à la spec](README.md)

## Mémoire et skills

### Mémoire

La mémoire est un **service de domaine indépendant du cerveau**, fourni par un plugin. Son contrat vit dans `packages/contracts/src/memory.ts` ; le noyau ne connaît ni ses données ni son stockage. Le fournisseur livré est `plugins/memory/local` (`memory`). Un fournisseur distant pourra implémenter le même contrat ; aucun connecteur Honcho ou Mnemosyne n'est livré pour le moment.

- **2 petits fichiers Markdown toujours dans le prompt** : `USER.md` (profil de l'utilisateur, ~1 400 caractères) et `MEMORY.md` (notes de l'assistant, ~2 200 caractères). Quand un fichier est plein, l'écriture échoue et le modèle doit résumer ou supprimer.
- **Historique des conversations** dans SQLite avec FTS5 (`node:sqlite`, intégré à Node 24), consulté avec l'outil `chercher_historique`, jamais injecté d'office.
- **Contexte relu à chaque tour**, en local comme avec un cerveau CLI. Le mode Live reçoit également les mises à jour. Les souvenirs sont des données, jamais des instructions. Le contexte facultatif est borné à 2 s par opération pour qu'un fournisseur indisponible ne bloque pas la conversation. Le budget est commun aux lecteurs et au vocabulaire ; les appels imbriqués respectent également le signal de leur appelant. Relire des données différentes peut changer le préfixe du prompt et son cache.
- **Remplissage** : outil `memoriser` pendant le tour, et sur demande (« Souviens-toi que... », « Oublie ça »). Plus tard : relecture après plusieurs tours, et résumé du soir.
- **Relecture par l'utilisateur** : chaque écriture passe par l'accord (niveau `write`). Une écriture est refusée si la note a changé entre-temps.
- Le contrat accepte des résultats immédiats ou asynchrones et un signal d'annulation. `snapshot`, `record`, `search` restent disponibles ; `corrections`, `saveCorrection`, `forgetCorrection` sont des capacités facultatives. Un seul fournisseur est choisi par le mécanisme de services existant (`services.memory`).
- Les tours utilisateur/assistant sont enregistrés une seule fois : le cerveau AI SDK possède leur enregistrement, la conversation complète les cerveaux directs qui ne le font pas, et Live possède ses tours même s'il délègue au cerveau.
- La préparation du contexte (mémoire, vocabulaire, disponibilité et avertissements bilingues) est partagée dans `packages/toolkit/src/memory-context.ts` (ses types dans `packages/contracts/src/memory-context.ts`), hors du noyau et sans dépendance vers un plugin concret. `managesMemory` indique que le cerveau prépare, observe et enregistre ses propres tours ; sinon la conversation prend ces opérations en charge. `recordMemory: false` laisse l'observation et l'enregistrement à l'appelant. Une délégation Live transmet aussi `memoryContext`, le résultat déjà préparé : le cerveau le réutilise sans nouvelle lecture ni deuxième injection. `undefined` demande une préparation ; `null` indique une préparation sans fournisseur. Ces champs organisent la responsabilité du tour, sans choisir le fournisseur ni son stockage.

### Corrections du vocabulaire (implémenté)

Le plugin `plugins/voice/vocabulary` (`vocabulary`) fournit le service `vocabulary`, utilise la mémoire choisie et expose `lister_corrections` (read), `corriger_vocabulaire` (write), `oublier_correction` (delete). Il est livré dans le catalogue et la config d'exemple. [Guide utilisateur](../guide/vocabulaire.md).

- Une correction explicite comme « non, je dis Core Team » est proposée par le cerveau à l'outil, sans nécessiter « mémorise ». Le plugin vérifie la phrase corrective contre le vrai tour utilisateur récent, sa session et son corps d'origine. Le fragment mal reconnu doit apparaître dans le tour précédent, sauf si la phrase actuelle nomme explicitement les deux formes (« corrige court team en Core Team », « pas court team mais Core Team »). Le nom corrigé doit apparaître dans la preuve. « Non, Alice » et « je veux dire Alice » peuvent être des changements d'avis : ces formulations seules n'autorisent pas une correspondance durable. Une correction non reconnue grammaticalement doit être reformulée. Il n'y a ni entraînement du STT ni extraction générale des préférences.
- Une preuve est réservée avant l'appel asynchrone au fournisseur : deux appels concurrents ne peuvent pas l'utiliser. Un rejet confirmé permet une nouvelle tentative ; un délai dépassé ou une annulation conserve la réservation, car le fournisseur pourrait encore terminer l'écriture. Une nouvelle correction exige alors un nouveau tour utilisateur.
- La mémoire locale conserve les corrections dans une table SQLite transactionnelle de `memory/history.db` : variante entendue, forme canonique, portée exacte (`domain`, `account`, `container`), preuve, dates et version. Les anciens fichiers Markdown et l'historique restent intacts. Une contradiction exige l'id et la version de la correction remplacée ; les doublons de casse/espaces ne créent pas d'entrée supplémentaire. La capacité est bornée à 2 000 corrections.
- Les cerveaux reçoivent les candidats pertinents dès le tour suivant. Le service sait résoudre un fragment dans une portée exacte et conserve les ambiguïtés. Le modèle utilise le nom corrigé pour interroger l'outil métier, qui reste responsable de trouver les vrais identifiants. Aucun remplacement global de transcription, contenu de message, citation, dictée, mot d'activation ou réponse d'accord n'est effectué.
- Le Live entend directement l'audio : son contexte est actualisé à l'ouverture et autour des tours/outils. Modifier seulement ses sous-titres n'aurait aucun effet sur son interprétation. L'apprentissage reste limité aux transcriptions réellement observées et aux outils Floppy.
- Chaque écriture passe par le noyau. La config d'exemple autorise uniquement `vocabulary/corriger_vocabulaire` au niveau `write` via `approvals.toolRules`. Le réglage `vocabulary.automatic` peut imposer de redemander ; il n'accorde pas lui-même un droit absent de la config. Un `never` global reste prioritaire. L'oubli demande toujours un accord.
- Le serveur MCP peut recevoir un contexte de tour attaché par l'hôte au jeton ; les paramètres du modèle ne peuvent pas fournir cette identité. Les cerveaux externes OpenCode, Pi, Oh My Pi et Hermes lient leur jeton restreint au tour hôte et libèrent cette liaison à la fin, y compris en cas d'erreur ou d'annulation. Les missions autonomes ne reçoivent pas une identité vocale par déduction. Si plusieurs conversations distinctes partagent simultanément le jeton principal, aucune session n'est attribuée et l'apprentissage refuse l'écriture ambiguë.
- Une délégation peut garder son historique dans une session distincte (`:delegate`). Son `toolContext` transporte séparément la session, l'origine et le tour hôte : les outils retrouvent ainsi la vraie observation utilisateur. Le texte de tâche rédigé par le modèle n'est pas une nouvelle preuve et n'est pas réobservé comme une parole de l'utilisateur.
- Les corrections sont consultables et supprimables par les outils. Le fournisseur de mémoire peut être remplacé sans modifier les cerveaux ; les capacités non prises en charge sont signalées. Export/import universel, connecteurs distants et écran dédié de gestion restent à réaliser.

### Observabilité en fonctionnement

Les événements sont écrits dans l'audit JSONL existant, consultable par `floppy log 200` ou dans `<dossier Floppy>/audit.jsonl`. Ils sont corrélés par `session`, `origin`, `turn` et, pendant une opération d'outil, `callId` fixé par le registre. Ils décrivent plusieurs étapes distinctes :

| `kind` | Mesure |
|---|---|
| `memory.context` | Lecture/enregistrement/observation côté conversation : service, phase, résultat (`outcome`) et `duration_ms`, y compris timeout et annulation. |
| `vocabulary` | `event` : tour observé, correction proposée/acceptée/rejetée/oubliée, candidats sélectionnés, résolution, erreur fournisseur. IDs/versions, compteurs, motif et durée `ms` selon l'événement. |
| `memory.store` | Stockage local : opération, statut, `duration_ms`, compteurs, identifiant/version et résultat d'insertion/remplacement/déduplication/suppression ; aucun texte de requête ni erreur brute. |
| `approval` / `tool` | Décision du noyau et résultat réel de l'appel, reliés par le même `callId`. |

`context.selected` prouve qu'une correction a été **fournie au cerveau**, pas qu'il l'a utilisée. Examiner les appels d'outils du même tour pour comprendre l'action effectivement tentée. Les tests simulés ne remplacent pas cette observation du modèle en fonctionnement.

Les nouvelles traces ne recopient pas par défaut les variantes, noms corrigés, preuves ou portées personnelles. Les outils de vocabulaire déclarent `auditArgs` pour limiter leurs paramètres journalisés aux métadonnées ; le registre masque également leur erreur brute. Le réglage `vocabulary.trace_text` (clic/CLI, désactivé par défaut) permet une trace dédiée du texte de correction, bornée, pour le diagnostic. Le désactiver arrête les nouvelles traces détaillées sans supprimer celles déjà écrites. L'audit antérieur de Floppy peut toujours contenir des transcriptions et les paramètres d'autres outils ; cette option n'est pas un mode de confidentialité global.

Le stockage et le journal ont des rôles séparés : les connaissances durables vivent dans la base, les traces suivent la rotation existante de l'audit (20 Mo puis fichier précédent). Une suppression de correction retire la connaissance active ; elle n'efface pas rétroactivement l'historique des conversations ni l'audit. [Procédure de diagnostic](../guide/vocabulaire.md#auditer-le-fonctionnement).

### Skills (cible, non implémentée)

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
