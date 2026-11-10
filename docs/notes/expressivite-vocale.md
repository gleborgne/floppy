# Expressivité vocale : moteurs et chaîne de parole

Recherche du 10 novembre 2026. Sources primaires vérifiées ; aucune audition, aucun appel TTS payant et aucune mesure sur cette machine. Les priorités ci-dessous sont des candidats d'essai, pas un classement sonore démontré. Complète [la recherche sur les TTS locaux](tts-local-francais-recherche.md).

## Choix à comparer

| Choix | Intérêt | Limite à vérifier |
|---|---|---|
| Gemini TTS, Sulafat / Achird / Puck / Aoede | Direction vocale par instructions ; quatre caractères de voix différents | Adapter le moteur/API et mesurer le délai avant le premier son |
| ElevenLabs v4 ou v4 Turbo | Balises expressives dans le texte ; alternative aux anciens modèles Flash | L'adaptateur Floppy actuel ne transmet pas les émotions |
| Qwen3-TTS CustomVoice **1.7B** | Pilotage par instructions déjà raccordé dans Floppy | Les voix intégrées n'ont pas de profil natif français |
| VoxCPM2 | Clonage français et consignes de jeu, local, licence Apache-2.0 | Raccorder les consignes au chemin audio.cpp et tester le résultat |
| Fish S2 Pro | Balises émotionnelles déjà adaptées côté Floppy | Licence restrictive : essai distinct d'un choix de distribution permissive |

### Gemini

Google décrit Sulafat comme chaleureuse, Achird comme amicale, Puck comme enjouée, Aoede comme légère. Ce sont de bons points de départ à écouter sur les mêmes phrases françaises. La documentation actuelle présente Gemini 3.8 Flash TTS et Flash-Lite TTS, avec français, streaming et bibliothèque de voix. Il faut distinguer les capacités de ces modèles du modèle effectivement configuré dans Floppy : changer le nom de la voix ne met pas l'intégration à niveau. [Documentation officielle actuelle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview?hl=en).

L'adaptateur Floppy appelle actuellement `generativelanguage.googleapis.com` ; la disponibilité documentée côté Google Cloud ne prouve pas la compatibilité immédiate des mêmes identifiants sur cet endpoint.

Les instructions peuvent préciser le personnage, la situation et la façon de parler : émotion, débit, accent. Exemple de direction à essayer : « Conversation familière en français ; sourire discret, satisfaction sincère, petite pause avant le résultat ; souligner “c'est réglé” sans crier. » [Guide de direction vocale](https://ai.google.dev/gemini-api/docs/speech-generation?authuser=50&hl=en).

### ElevenLabs

La documentation actuelle recommande v4 ; v4 et v3 acceptent des balises d'émotion, d'interprétation et de réactions humaines, par exemple `[curious]`, `[whispers]`, `[laughs]`. Elle indique aussi v4 Turbo pour le temps réel et les endpoints de streaming. Les modèles v3/v4 ne prennent pas en charge les pauses SSML comme les anciens modèles. Ne pas appliquer les mêmes réglages à toutes les familles. [Guide officiel](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech), [modèles](https://elevenlabs.io/docs/fr/overview/models).

### Local

**Qwen3-TTS :** le tableau officiel distingue CustomVoice 1.7B, qui accepte les instructions, de CustomVoice 0.6B et Base, qui n'offrent pas ce même contrôle. Le français fait partie des langues supportées. Ryan est décrit comme dynamique et Serena comme douce et chaleureuse, mais leurs langues natives sont respectivement l'anglais et le chinois ; l'amont recommande la langue native pour la meilleure qualité. Le projet est Apache-2.0 et annonce du streaming ; ses chiffres de latence ne sont pas une mesure du port Floppy. [Dépôt officiel](https://github.com/QwenLM/Qwen3-TTS).

**VoxCPM2 :** la fiche confirme le français, le clonage avec consignes de style entre parenthèses en tête du texte, le streaming et Apache-2.0. La référence vocale et la consigne peuvent être combinées pour conserver le timbre tout en modifiant l'émotion. L'amont prévient que le style varie entre générations et que les entrées très expressives peuvent devenir instables. C'est mon premier candidat local pour une voix française personnalisée ; cette priorité est une déduction à valider par écoute. [Fiche officielle](https://huggingface.co/openbmb/VoxCPM2).

**Fish S2 Pro :** voir les sources et conditions dans [la note locale](tts-local-francais-recherche.md#modèles-à-considérer-séparément). Le raccordement des balises présent dans Floppy permet un comparatif utile, sans conclure à une licence permissive.

## Deux alternatives à ne pas surévaluer

Cartesia Sonic 3.6 prend en charge le français et peut tirer une prosodie du texte. Mais sa documentation précise que les **balises d'émotion sont supportées uniquement en anglais** : ce n'est donc pas mon premier candidat pour une direction émotionnelle française explicite. [Modèle](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest), [contrôles](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion).

Chatterbox Multilingual V3 parle français et propose `exaggeration` / `cfg_weight` sous MIT. Augmenter l'exagération tend aussi à accélérer la parole. Les balises paralinguistiques de Turbo ne doivent pas être attribuées automatiquement au multilingue. Son README annonce l'arrêt de maintenance depuis août 2026. [README officiel](https://raw.githubusercontent.com/resemble-ai/chatterbox/master/README.md).

Hume Octave n'est pas un nouveau fournisseur à intégrer : la documentation officielle annonce la fin d'accès TTS/EVI le **13 novembre 2026 à 00:01 EST**. [Avis Hume](https://dev.hume.ai/voice/docs/text-to-speech-tts/overview).

## Ce que Floppy perd actuellement

Constats issus de la lecture du code, à distinguer d'une mesure acoustique :

- [speechInstructions](../../packages/toolkit/src/speech-delivery.ts) fabrique des consignes à partir de l'intention, du profil et du ton, sans utiliser directement `emotion` ni `intensity`.
- La conversation ramène plusieurs émotions à quatre intentions. `happy`, `proud`, `surprised` et `relieved` aboutissent à l'intention neutre ; `joy` et `excited` sont regroupées avec le jeu.
- L'adaptateur ElevenLabs utilise par défaut `eleven_flash_v2_5`, ne consomme pas `opts.delivery` et n'envoie pas de `voice_settings`.
- [L'adaptation audio.cpp](../../plugins/tts/audiocpp/src/expression.ts) reconnaît surtout Qwen CustomVoice 1.7B et Fish S2 sous leurs noms attendus. Ajouter un autre modèle au catalogue ne raccorde pas automatiquement son expressivité.
- Fish reçoit une seule balise pour une phrase, avec un seuil d'intensité ; augmenter fortement l'intensité ne produit pas une direction de jeu proportionnellement plus forte.
- La génération par phrases de `SpeechQueue` / `SentenceSplitter` ne donne pas le contexte voisin à chaque synthèse. Une prosodie qui redémarre à chaque phrase est une hypothèse à auditionner, pas un défaut sonore démontré.

## Améliorations proposées

1. **Rendre le contrôle effectif visible.** Déclarer par modèle les capacités réellement raccordées : instruction libre, émotion, intensité, pauses, accentuation, contexte, clonage. Un réglage inutilisé ne doit pas sembler actif.
2. **Traduire l'émotion en jeu vocal concret.** Conserver une identité stable puis ajouter émotion, intensité et intention par segment. Une confirmation satisfaite, une explication concentrée et une réponse rassurante demandent davantage qu'un simple changement de débit.
3. **Séparer texte prononcé et direction.** L'affichage garde le texte propre ; chaque adaptateur transforme la direction en instructions ou balises reconnues. Éviter que la voix lise les indications.
4. **Conserver une continuité.** Comparer phrase isolée, petit groupe de phrases et contexte conservé lorsque le moteur le permet. Cartesia documente explicitement ce compromis entre contexte prosodique et latence ; ce constat justifie l'expérience, sans prouver le résultat pour les autres moteurs. [Buffering officiel](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering).
5. **Évaluer à voix égale avant de changer de fournisseur.** Étendre le comparatif existant `bench/voice-compare.ts` : même texte et même voix, sans direction puis avec direction, puis changement de moteur. Écouter confirmation, surprise, compassion, plaisanterie discrète, explication longue et demande d'accord. Noter naturel, cohérence émotionnelle, fidélité au texte, accent, fatigue à l'écoute et délai avant le premier son.

Un premier lot raisonnable serait d'améliorer les consignes Qwen/Gemini, raccorder ElevenLabs à un modèle expressif, puis comparer VoxCPM2 avec une référence française. Chaque comportement implémenté demandera ses tests et `npm run check` ; cette note ne modifie aucun comportement.
