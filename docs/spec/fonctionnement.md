# Fonctionnement

[← Retour à la spec](README.md)

## Un tour de conversation

1. Le mot d'activation local détecte « Floppy » (thread dédié). L'icône passe à « écoute ».
2. Le fournisseur `voice` détecte la fin de la phrase et la transcrit.
3. Le `brain` (agent AI SDK) reçoit le texte avec la mémoire courte et le ton. Un seul appel au LLM : il répond directement, ou il appelle des outils (MCP, corps, internes). Pas de modèle de décision devant (retiré de la v1, voir [Le cerveau](cerveau.md#le-modèle-de-décision--retiré-de-la-v1)).
4. Si une demande est ambiguë, l'assistant pose une question au lieu d'agir (prompt v3c, prototype 4 : 100 % des demandes ambiguës). Une demande difficile est déléguée au gros LLM ; le noyau dit une phrase d'attente. Implémenté : voir [Le premier proto](proto.md).
5. Chaque appel d'outil passe par le noyau : règles, niveau de l'outil, accord de l'utilisateur si besoin, journal. Si un outil prend du temps, l'assistant dit une phrase d'attente et la progression s'affiche dans la bulle.
6. La réponse est dite par `voice`, avec le ton choisi. `display` montre la bulle ou l'UI A2UI. `body` montre l'émotion.
7. Après la réponse, une **écoute libre** de quelques secondes permet d'enchaîner sans le mot d'activation. Ce qui compte est le **début** de la parole : une phrase commencée pendant l'écoute libre est écoutée même si sa transcription arrive après la fin de la fenêtre.
8. L'utilisateur peut **interrompre** l'assistant à tout moment. Quand le micro entend de la voix pendant que l'assistant parle, le bureau **suspend** la lecture sans perdre les mots. Le texte reconnu tranche : s'il reprend ce que l'assistant vient de dire (2 mots qui se suivent, ou 70 % des mots dès 3 mots), c'est l'**écho** de sa voix ; la lecture reprend et le texte est ignoré. Un acquiescement ou une hésitation isolée (« oui », « yeah », « mhm », « euh ») reprend aussi la lecture : ce signal ambigu, parfois halluciné par le STT, ne détruit pas une explication. Cette règle ne s'applique ni aux accords attendus, ni au bouton parler, ni à une adresse explicite avec le mot d'activation, ni après la fin de lecture. « Stop », « attends », « non » et une vraie phrase interrompent : tout s'arrête et l'écoute libre se rouvre, la phrase est écoutée sans le mot d'activation. Sans texte reconnu (2,5 s après la fin de la parole, 8 s au plus), la voix reprend. Le bouton parler coupe tout de suite. Une phrase coupée par une pause est recollée.
Une demande peut aussi être saisie avec **Ctrl+Alt+T** (réglable dans Système). Elle rejoint le corps vocal de l'avatar sans mot d'activation : le tour, la mémoire, les outils, les accords et la réponse à voix haute suivent le même chemin qu'après une transcription. Une nouvelle demande interrompt la réponse précédente. « Oui » et « non » tapés répondent à l'accord en cours. La saisie réveille Floppy ; « dors » le remet en veille. Les clients texte comme `floppy chat` restent des conversations à réponse écrite.

Dans la bulle de conversation, « Je t'écoute… » suit l'état `listening` du noyau : recevoir une transcription ne
masque pas cet indicateur. Il reste sous le texte défilant, avec une croix « Arrêter l'écoute » qui envoie `listen.stop`
au noyau : l'écoute libre se ferme et Floppy revient au repos, sans devenir muet. Les annonces importantes restent vocales et le mot d'activation continue de fonctionner. Un clic tardif pendant une réponse est ignoré. La commande « dors » et le mode muet restent les seuls à demander la veille.

### Règles de tour (conversation)

- **Un verrou par corps** : deux corps répondent en parallèle (un message Telegram n'attend pas une longue réponse vocale) ; un même corps garde un seul tour à la fois. Les émotions restent envoyées à tous les corps.
- **Longue pause** (`idle_reset_s`) : le cerveau est prévenu par `rest(session)` s'il existe (il garde un court résumé), sinon par `reset(session)` (oubli complet).
- **« Répète »** : une phrase courte (7 mots au plus après le mot d'activation, avec seulement des mots de politesse autour : « répète », « redis », « tu peux répéter, s'il te plaît », « pardon ? » ou « comment ? » dits seuls, « repeat », « say that again », « come again »…) redit la dernière réponse du corps, terminée ou interrompue, sans appeler le cerveau (voix : dite directement ; texte : `reply.done`). Audit `reply.repeated`. Les phrases d'attente et les demandes d'accord ne comptent pas ; sans dernière réponse, la phrase passe au cerveau. « Répète après moi… » n'est pas une demande de répétition.
- **Erreurs qui disent la cause** : aucun cerveau actif, silence trop long du cerveau, erreur réseau (fetch échoué, connexion refusée, délai) ou autre, chacun avec sa phrase courte dans les deux langues. `error_reply` ne remplace que le cas « autre ».
- **État du corps** : `body-state.ts` calcule « peut-on écouter sans mot d'activation » d'après les drapeaux, et tient la table des transitions prévues. Une transition hors table est journalisée (debug + audit `state.unexpected`), jamais refusée.
- **Découpe des phrases** : une phrase est coupée sur `. ! ? … ; :` suivi d'un blanc, sauf si le point termine une abréviation (M., Mme., Dr., etc., p. ex., cf., Mr., e.g., i.e., vs.), une initiale en majuscule (J. Dupont) ou un numéro de liste (1. Faire). La première phrase part toujours tôt.
- **Forme parlée** : avant la synthèse, chaque phrase dite (réponse, annonce, demande d'accord) passe par `spoken-form.ts`, dans la langue de l'assistant : heures (14:30 → « 14 h 30 » ; « 2:30 PM » en anglais), adresses web (« un lien vers contoso.com »), chemins (« un fichier rapport.docx »), identifiants longs (« un identifiant »), symboles (%, €, &, →). Le texte affiché à l'écran n'est jamais modifié.

## Tâches longues

- Une tâche longue (Claude Code, agent Orca) tourne en fond. L'assistant répond tout de suite (« OK, je transmets ») et l'utilisateur continue à parler.
- Quand la tâche finit, le noyau émet un événement. L'assistant prévient selon l'importance.

## Initiatives

- Sources : agents Orca qui finissent ou attendent, réunion proche, build cassé, rappel.
- **Important** : dit à voix haute, après la fin de la phrase de l'utilisateur.
- **Normal** : notification visuelle (bulle, icône).
- « Floppy, dors » ou le mode muet coupe aussi les annonces à voix haute.
- Une annonce reçue avant que le flux vocal soit prêt est mise en file, puis la file est reprise dès l'ouverture de la voix. Cacher l'avatar ne coupe pas ces annonces ; la veille explicite continue de les différer.

## Config à la voix

| Exemple | Règle |
|---|---|
| « Bascule la voix sur Gemini Live » | Accord, car c'est un plugin cloud (sauf s'il est déjà autorisé). |
| « Passe en ton sarcastique » | Tout de suite, avec annulation possible. |
| « Utilise Claude pour le cerveau » | Accord si le cloud n'est pas déjà autorisé pour `brain`. |
| « Donne-toi accès à mon dossier Documents » | Refusé à la voix : clic ou CLI obligatoire. |

La CLI permet tout : lister et activer les plugins, changer la config, accorder ou retirer des droits, lire le journal.

Implémenté : voir [Réglages à la voix](reglages.md) (risques free / ask / cli, voix, écoute libre, délégation).
