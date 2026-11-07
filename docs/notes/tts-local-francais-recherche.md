# TTS locaux français : expressivité et intégration

Recherche du 7 novembre 2026. Sources primaires consultées ; aucun modèle téléchargé, aucune audition ni mesure sur cette machine. Les appréciations ci-dessous sont des priorités d'essai, pas un classement de qualité sonore démontré.

## Choix proposés

**VoxCPM2 est le premier candidat à comparer à Qwen** : il combine français, clonage pilotable par une description et une licence Apache-2.0. **Chatterbox Multilingual** est intéressant pour une seconde écoute, avec une réserve de maintenance. **Supertonic 3**, déjà au catalogue Floppy, constitue un témoin utile pour la réactivité sur processeur. Les sources et limites de ces choix sont détaillées ci-dessous.

| Moteur | Intérêt pour Floppy | Limite principale |
|---|---|---|
| VoxCPM2 | Clonage et style dans la même génération ; chemin natif déjà reconnu | Vérifier le style dans le port audio.cpp et la régularité en français |
| Chatterbox Multilingual V3 | Français, clonage, jeu vocal réglable | Projet amont déclaré non maintenu ; ne pas confondre avec Turbo anglophone |
| Supertonic 3 | Petit modèle CPU, voix intégrées et événements expressifs | Amont archivé ; poids OpenRAIL-M ; pas un remplacement équivalent du clonage piloté |
| Parler-TTS Mini Multilingual v1.1 | Description textuelle du débit, de la hauteur et de l'expressivité | Nouveau moteur Python à intégrer et latence à mesurer |
| Kokoro 82M | Petit modèle, voix française dédiée | Contrôle émotionnel limité et une seule voix française officielle |
| Fish S2 Pro / Drama 3 | Contrôle fin des émotions et événements vocaux | Licences restrictives ; modèles plus exigeants |
| Voxtral TTS 4B | Français et génération expressive avec voix intégrées | Poids non commerciaux ; documentation BF16 demande 16 Go GPU |

## VoxCPM2

La fiche officielle décrit un modèle de 2 milliards de paramètres, 30 langues dont le français, avec clonage, création de voix et consignes de style permettant de modifier émotion et débit en conservant le timbre. Les descriptions se placent entre parenthèses en tête du texte ; le clonage contrôlable et la continuation avec transcription de référence sont deux chemins distincts. Le streaming est documenté. Le RTF annoncé autour de 0,3 concerne une RTX 4090 : ce n'est ni une mesure de latence initiale ni une prévision pour ce PC. [Fiche du modèle et exemples](https://huggingface.co/openbmb/VoxCPM2).

Code et poids sont annoncés sous Apache-2.0. [Licence du code](https://github.com/OpenBMB/VoxCPM/blob/main/LICENSE), [fiche des poids](https://huggingface.co/openbmb/VoxCPM2).

**Déduction :** meilleur premier essai pour obtenir une voix française personnelle et expressive. Il faut vérifier que le port natif reproduit les consignes de style ; sa présence dans la liste de familles ne prouve pas la qualité de chaque chemin.

## Chatterbox Multilingual

Le modèle multilingue V3 annoncé fait 500 millions de paramètres, prend en charge le français et clone une voix. Le code et la fiche des poids indiquent MIT. [Dépôt officiel](https://github.com/resemble-ai/chatterbox), [poids](https://huggingface.co/ResembleAI/chatterbox).

Le README documente `exaggeration` et `cfg_weight` : augmenter l'exagération peut également accélérer la parole, ce qui touche précisément le défaut de rythme signalé dans Floppy. Une référence française réduit le risque de transférer un accent étranger. Turbo et Nano sont présentés comme anglophones ; leurs balises de rire ne doivent pas être attribuées automatiquement au multilingue. Le README comporte désormais un avis d'arrêt de maintenance depuis août 2026. [README officiel actuel](https://raw.githubusercontent.com/resemble-ai/chatterbox/master/README.md).

**Déduction :** bon candidat d'écoute locale, mais pas une garantie de rythme stable ni un choix maintenu à long terme. L'exemple Python utilise CUDA ; aucune exigence mémoire universelle ou latence française sur ce PC n'a été vérifiée.

## Supertonic 3

Le README décrit 99 millions de paramètres, le français parmi 31 langues, une exécution locale sans GPU et dix balises d'expression, notamment rire, respiration et soupir. Les exemples passent par ONNX ; un serveur local est également documenté. Le dépôt officiel a été déplacé vers une organisation d'archives et annonce la fin du développement et du support. [README et état du projet](https://raw.githubusercontent.com/supertone-oss-archive/supertonic/main/README.md).

Code MIT ; poids OpenRAIL-M avec restrictions d'usage, distincts d'une licence permissive classique. [Licence du code](https://github.com/supertone-oss-archive/supertonic/blob/main/LICENSE), [licence des poids](https://huggingface.co/supertone-oss-archive/supertonic-3/blob/main/LICENSE).

**Déduction :** essai simple pour comparer la réactivité à Qwen, mais les balises ponctuelles ne remplacent pas une direction de jeu générale. Leur transmission et leur rendu via audio.cpp restent à tester.

## Parler-TTS et Kokoro

Parler-TTS Mini Multilingual v1.1 prend en charge le français et sépare le texte lu d'une description du locuteur et de son interprétation. La fiche donne un exemple français avec expressivité, vitesse et hauteur contrôlées par description. Code et poids Apache-2.0. C'est une piste de contrôle expressif, avec un serveur Python à ajouter et une latence locale encore inconnue. [Modèle](https://huggingface.co/parler-tts/parler-tts-mini-multilingual-v1.1), [code et licence](https://github.com/huggingface/parler-tts).

Kokoro est plus petit, à 82 millions de paramètres. Code et poids Apache-2.0. La voix française officielle est `ff_siwis` ; la liste documente une couverture française limitée, une sensibilité aux phrases très courtes et un risque d'accélération sur les longues. Le chemin Python français utilise eSpeak-NG pour la phonémisation ; ses dépendances doivent être examinées séparément avant distribution. **Déduction :** témoin de simplicité et de légèreté, moins prioritaire pour un jeu émotionnel piloté. [Modèle](https://huggingface.co/hexgrad/Kokoro-82M), [voix et limites](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [code](https://github.com/hexgrad/kokoro).

## Modèles à considérer séparément

Fish S2 Pro accepte des instructions expressives à l'intérieur du texte, et inclut le français dans son groupe de langues « Tier 2 ». Sa structure comprend un réseau de 4B et un réseau de 400M ; les quelque 100 ms annoncées avant le premier son concernent un GPU H200. Les poids sont sous Fish Audio Research License : utilisation non commerciale, accord séparé pour le commercial. [Fiche S2 Pro](https://huggingface.co/fishaudio/s2-pro). Le code actuel est sous Fish Audio Community License, avec conditions commerciales et restrictions de service hébergé ; ce n'est pas une dépendance permissive pour Floppy. [Licence du code](https://github.com/fishaudio/fish-speech/blob/main/LICENSE).

Drama 3 est une variante plus récente orientée scènes multivoix : 35B paramètres au total, 3B actifs, serveur SGLang-Omni ou vLLM-Omni, même famille de licence Research pour les poids. **Déduction :** à réserver à une expérimentation dédiée, pas au premier comparatif de l'assistant local. [Fiche officielle](https://huggingface.co/fishaudio/drama-3).

Voxtral 4B TTS propose le français et 20 voix intégrées ; la fiche recommande vLLM-Omni et au moins 16 Go de mémoire GPU pour ses poids BF16. Poids CC-BY-NC-4.0 ; ne pas confondre avec les modèles Mistral sous Apache. [Fiche officielle](https://huggingface.co/mistralai/Voxtral-4B-TTS-2603). NeuTTS Nano French est également une piste CPU avec clonage, mais ses poids sont soumis à acceptation et portent une licence spécifique ; pas retenu en priorité sans clarification de cette licence et du contrôle expressif. [Fiche officielle](https://huggingface.co/neuphonic/neutts-nano-french).

## Ce qui est réellement accessible depuis Floppy

Le code local référence audio.cpp **v0.9.4** dans [known-builds.ts](../../plugins/tts/audiocpp/src/known-builds.ts). Le catalogue de téléchargement contient Supertonic 3, Qwen CustomVoice et Pocket TTS, ainsi que les ajouts VoxCPM2 BF16, Chatterbox multilingue Q8, Voxtral TTS Q8 et Fish Audio S2 Pro Q8 dans [known-voices.ts](../../plugins/tts/audiocpp/src/known-voices.ts). Leur installation et leur configuration sont testées avec des téléchargements simulés ; aucune audition n'est revendiquée. L'expressivité automatique `SpeechDelivery` y est actuellement traduite uniquement pour Qwen CustomVoice 1.7B. Voir les contraintes des nouveaux paquets dans [Téléchargements](../spec/telechargements.md).

### OmniVoice, Kokoro et découverte dynamique

OmniVoice est déjà une famille audio.cpp v0.9.4, avec clonage, création de voix par description et balises non verbales. Son flux est produit par morceaux de texte générés entièrement, et non par streaming natif du modèle. Il constitue un candidat supplémentaire pour l'expressivité ; il n'est pas encore ajouté au catalogue Floppy. [Documentation du port](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/docs/models/omnivoice.md).

Kokoro demande la bibliothèque eSpeak et ses données pour le français. Les fiches `model_specs` ne suffisent pas à identifier ce besoin : `kokoro_tts.json` expose une liste `dependencies` vide, tandis que la documentation détaille cette dépendance native. Le téléchargement du seul GGUF ne rend donc pas nécessairement Siwis utilisable. [Ressources et validation multilingue](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/tests/kokoro_tts/MULTILINGUAL_GGUF.md).

Le dépôt Hugging Face [audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf) porte bien le tag `audio.cpp`. Pour un futur catalogue dynamique, utiliser les `model_specs` de la version du serveur prise en charge comme registre des familles, modes et paquets, puis l'API Hugging Face pour les fichiers, tailles et SHA-256. Garder un cache hors ligne, figer le commit et les empreintes au téléchargement, et compléter les fiches avec les contraintes vérifiées côté Floppy (ressources natives, licences par modèle, voix, référence et fréquence PCM). Cette découverte dynamique est une proposition, pas une fonctionnalité déjà implémentée.

La documentation de la version v0.9.4 d'audio.cpp liste notamment VoxCPM2, Chatterbox, Kokoro, Supertonic, Fish et Voxtral. Cela facilite un essai natif, sans prouver leur intégration complète à Floppy. Les GGUF doivent correspondre à la famille et au format audio.cpp ; un GGUF quelconque ne suffit pas. Le tableau de validation signale une dérive audio pour VoxCPM2 quantifié, même lorsque la transcription reste correcte. [README v0.9.4](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/README.md), [formats et validations](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/docs/gguf.md).

## Comparatif proposé

Garder Qwen comme référence et comparer d'abord VoxCPM2 puis Supertonic 3 sur les mêmes textes français : explication de l'arc-en-ciel, réponse rassurante, plaisanterie, question et nombres/noms propres. Répéter chaque texte plusieurs fois, puis faire une réponse complète de plusieurs phrases. Mesurer délai du premier son, blancs entre phrases, variation du débit, omissions et délai d'arrêt après interruption. Écouter séparément naturel, accent, identité de voix et expressivité. Une transcription correcte ne suffit pas à valider le phrasé.

Ces essais doivent conserver le même découpage et le même lecteur audio Floppy : sinon une différence d'orchestration peut passer pour une différence de moteur. Aucun changement de moteur par défaut n'est proposé avant cette comparaison.
