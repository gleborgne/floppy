# Télécharger des modèles depuis les réglages

Comme LM Studio ou Handy : dans Réglages, sous chaque rôle (cerveau, transcription, détecteur de parole, voix),
le bouton **Télécharger des modèles** ouvre une fenêtre avec des modèles prêts à l'emploi. Un clic les télécharge ;
une fois sur le disque, ils rejoignent la liste du rôle, prêts à activer. Rien à taper, aucun chemin à chercher.

## Ce que voit l'utilisateur

- **Sous la liste d'un rôle** : « Télécharger des modèles ». Pendant un téléchargement, le bouton le dit
  (« · 1 en cours · 42 % »), même fenêtre fermée.
- **La fenêtre « Modèles à télécharger »** : les modèles choisis par Floppy, et pour le cerveau une case de
  recherche sur Hugging Face. Pour audio.cpp, un bouton d'actualisation du catalogue et un filtre local complètent
  la liste (compatibilité vérifiée, qualité sonore à évaluer). Chaque ligne : nom, une phrase, étiquettes (taille, licence, langues, mémoire
  estimée), et ses boutons :
  - **Télécharger** (avec son icône) ; **Écouter** (un extrait, s'il existe) et **Licence** s'ouvrent dans le navigateur ;
  - pendant le téléchargement : une barre d'avancement, « 42 % · 1,2 / 2,9 Go », **Annuler** ;
  - en cas d'échec : le message sous la description, **Réessayer** (reprend là où il s'est arrêté) ;
  - une fois fini : « ✓ Installé », **Supprimer** (2 clics : le 2e confirme). Supprimer efface les fichiers et retire
    le modèle de la liste ; un modèle en service est refusé (« choisis d'abord un autre … »).
- **Fin d'un téléchargement** : une carte « Gemma 4 12B est téléchargé. » (sans voix), même fenêtre fermée.
- **Licence** : le pied de la fenêtre dit que télécharger un modèle, c'est accepter sa licence.
- **Défilement** : les cartes de chaque section conservent leur hauteur dans la liste. Le conteneur central
  défile jusqu'au dernier modèle ; les lignes ne sont pas comprimées et masquées quand plusieurs catalogues sont présents.
- **Dossier** : toujours `models` dans le répertoire de travail de Floppy (pas de réglage à part :
  changer le répertoire de travail déplace aussi les modèles). Chaque entrée de la config range ses fichiers dans `<dossier>/<entrée>/`.

## Le noyau : `ctx.downloads`

Le noyau télécharge des fichiers ; il ne connaît aucun site ni aucun modèle (`packages/core/src/downloads.ts`).

- `start({ key, label, files: [{ url, path, size?, sha256? }] })` lance et rend la main tout de suite (une requête de
  la fenêtre expire à 60 s). Relancer un téléchargement en cours rend son état.
- `get(key)`, `cancel(key)`, `onChange(fn)` ; `dir` : le dossier de l'entrée.
- **Sûr** : `path` reste dans `dir` (pas de `..`, pas de chemin absolu) ; adresse http(s) seulement ; l'hôte doit être
  dans `permissions.net` du manifeste (« huggingface.co », « *.hf.co »). Les redirections (CDN) suivent le serveur permis.
- **Fiable** : écrit dans `<fichier>.part`, reprend un fichier coupé (en-tête `Range` ; sans reprise du serveur,
  recommence), vérifie la taille et le sha256, puis renomme. Un fichier abîmé est jeté. Un fichier déjà là, de la
  bonne taille, n'est pas retéléchargé. Annuler jette les fichiers partiels.
- **Nouveaux essais** : une panne (réseau coupé, serveur en panne, fichier abîmé) relance le téléchargement 3 fois
  (5 s, 30 s, 2 min ; `DownloadManagerOptions.retryMs`), en reprenant où il en était ; `DownloadState.retry` donne le
  numéro de l'essai (« nouvel essai 1 » dans la ligne). Adresse fausse ou refusée (4xx sauf 408, 429) et décompression
  ratée : échec tout de suite.
- **Une file pour tout le noyau** : 2 téléchargements à la fois, les autres attendent. Avancement annoncé au plus
  4 fois par seconde.
- Les téléchargements continuent si le plugin redémarre (la file est au noyau).

## La bibliothèque : `modelLibrary(ctx, …)`

Aide pour les plugins (`packages/core/src/model-library.ts`). Le plugin donne ses modèles (`entries`, fichiers figés
à un commit, avec sha256), et dit quoi faire quand un modèle est prêt (`installed` : ajouter l'élément), quand il est
supprimé (`removed` : retirer l'élément, ou refuser par une `TextError`), et s'il a déjà l'élément (`has`). Optionnel :
`search(query)` pour une recherche en ligne.

Elle déclare un fournisseur `layout: "library"` avec `offers` (les services que ces modèles rendront). La fenêtre ne
le montre pas dans la page : elle met le bouton sous les rôles de ces services. Ses éléments portent `progress`
(0 à 1) et leurs boutons (`download`, `cancel`, `remove`, `use`, `listen`, `licence`). Un modèle sur le disque mais
absent de la liste du plugin montre « Ajouter à la liste ». Deux modèles peuvent partager un fichier : Supprimer garde
ceux qu'un autre modèle installé utilise.

Catalogue : `ItemInfo.progress`, `ProviderDef.search` + `searchHint`, opération `{ op: "search", provider, query }`
(résultat : `items`). Chercher ne change rien : ni journal, ni mise à jour de la fenêtre ; refusé à la voix.

## Les plugins

| Plugin | Modèles choisis | Après le téléchargement |
|---|---|---|
| `stt-sherpa` (Écoute) | Silero VAD (GitHub sherpa-onnx), Parakeet TDT v3 int8 (miroir Hugging Face, fichier par fichier : pas d'archive à décompresser) | un élément : le fichier (détecteur) ou le dossier (transcription) |
| `tts-audiocpp` (Voix) | Pocket TTS français et anglais (avec leurs `embeddings/`), Supertonic 3, Qwen3-TTS 1.7B CustomVoice, VoxCPM2 BF16, Chatterbox multilingue Q8, Voxtral 4B TTS Q8, Fish Audio S2 Pro Q8 | **une voix intégrée par élément** ; pour les trois modèles proposés en clonage, une fiche de voix à personnaliser |
| `llm-llamacpp` (Cerveau) | Qwen3.5 4B et 9B, Gemma 4 E4B et 12B (QAT), Mistral Small 3.2 24B | un modèle du cerveau, prêt à activer |

**Recherche Hugging Face** (cerveau, `plugins/llm/llamacpp/src/hf.ts`) : les 8 dépôts GGUF les plus téléchargés pour
la requête ; pour chacun, au plus 3 quantifications (Q4_K_M d'abord, puis Q4_0, Q5_K_M, Q6_K, Q8_0…). Un modèle en
plusieurs fichiers (`-00001-of-0000N`) est une seule ligne. Ignorés : dépôts protégés (accord à signer), fichiers
sans empreinte, `mmproj`. Chaque fichier est figé au commit lu. Étiquette « ≈ N Go de mémoire » : le fichier + ~1,2 Go
(contexte, tampons) ; le bouton Essayer d'un modèle donne l'estimation détaillée.

Chaque entrée dit aussi ce qu'elle demande (`needs` : mémoire, processeur ou puce graphique, moteurs), le service
qu'elle rend (`service`) et, une fois installée, l'élément qu'elle donne (`itemOf` → `ItemInfo.uses`). Le premier
lancement s'en sert pour choisir les modèles qui tiennent dans la machine : voir [Premier lancement](premier-lancement.md).

### Catalogue audio.cpp étendu (7 novembre 2026)

Les quatre nouveaux paquets viennent du dépôt `audio-cpp/audio.cpp-gguf`, figé au commit
`73ce4162f6cce370dd533c6782b772135c1b2a8e`, avec taille et SHA-256 des objets LFS. Les familles et modes sont
vérifiés contre les `model_specs` d'audio.cpp **v0.9.4**. La mention du catalogue est désormais
« compatibles audio.cpp · qualité à évaluer sur ta machine » : aucune audition locale n'est revendiquée.

- **VoxCPM2 2B BF16** (4,77 Go, Apache-2.0) : une fiche de voix clonée à enregistrer/importer. BF16 est retenu
  pour ce premier essai ; le guide GGUF amont signale une dérive sonore du Q8 sur son cas de validation.
- **Chatterbox multilingue Q8** (2,09 Go, MIT) : une fiche de voix clonée. Le mode est `offline`, seul mode
  annoncé par ce port ; chaque phrase est générée entièrement, puis reçue en WAV. Le catalogue n'affirme pas
  utiliser spécifiquement la variante V3 (le paquet contient plusieurs variantes).
- **Voxtral 4B TTS Q8** (4,72 Go, CC-BY-NC-4.0) : 20 fiches de voix intégrées, dont `fr_female` et `fr_male`
  en premier. Le checkpoint ne fournit pas l'encodeur nécessaire au clonage. Le flux PCM est à 24 kHz.
- **Fish Audio S2 Pro Q8** (6,32 Go, Fish Audio Research License) : une fiche de voix clonée, avec transcription
  obligatoire de l'enregistrement, transmise par la bibliothèque audio.cpp. Le flux PCM est à **44,1 kHz**.

Les fiches de clonage sans enregistrement (ou sans texte pour Fish) restent visibles, à compléter, mais ne sont
pas offertes comme voix activables et n'ont pas de bouton « Utiliser » dans la bibliothèque. Enregistrer la voix
les rend disponibles ; télécharger à nouveau ne les duplique pas. Supprimer le modèle retire les fiches associées.
L'action « Ajouter les autres voix intégrées » reconnaît également les modèles du catalogue et Voxtral ajouté
manuellement ; elle garde les identifiants natifs, notamment la casse des voix Supertonic.

Les restrictions non commerciales de Voxtral et Fish sont visibles avant téléchargement (description, étiquette
et lien de licence). Ces poids ne sont pas livrés avec Floppy. Les budgets mémoire des nouvelles familles sont
indicatifs (poids + marge), pas des mesures de performance. Le profil expressif automatique est décrit dans
[Corps et avatar](corps-et-avatar.md#profil-dexpressivité) : Qwen CustomVoice 1.7B et Fish S2 Pro sont adaptés ;
l'ajout d'une autre famille au catalogue ne suffit pas à activer un pilotage expressif.

Parler-TTS n'a pas de famille dans audio.cpp v0.9.4 et n'est pas ajouté à cette bibliothèque. Kokoro nécessite
en plus les ressources eSpeak pour le français ; son téléchargement guidé reste à intégrer.

### Actualisation du catalogue audio.cpp

Dans **Voix → Télécharger des modèles**, **Actualiser le catalogue** consulte les `model_specs` GitHub à la
version `AUDIOCPP_VERSION` du programme proposé par Floppy, puis les métadonnées Hugging Face. Ni l'ouverture
de la fenêtre ni le démarrage du plugin ne font de requête. L'action ne télécharge aucun poids et ne change
ni le moteur, ni la voix active. Un filtre par nom, famille ou étiquette fonctionne sur la liste locale.

`plugins/tts/audiocpp/src/catalogue.ts` complète les fiches amont avec les profils Floppy : Pocket FR/EN et
toutes leurs empreintes vocales, Qwen CustomVoice 1.7B, **Qwen Base 0.6B/1.7B**, Supertonic 3, VoxCPM2,
Chatterbox multilingue, Voxtral, Fish S2 Pro et **OmniVoice**. Les variantes GGUF sont découvertes dans les
fiches, sans coder chaque quantification, taille ou empreinte dans Floppy. OmniVoice crée une voix à
enregistrer/importer ; sa transcription est facultative et le flux PCM est à 24 kHz. Son flux est produit
par morceaux de texte générés entièrement, sans promesse de latence ni de pilotage expressif automatique.

Le périmètre reste explicite : seuls les paquets du dépôt `audio-cpp/audio.cpp-gguf` avec profil reconnu sont
proposés. Les fine-tunes, VoiceDesign, les ressources NPU et les formats non GGUF ne sont pas déduits d'un tag.
VoxCPM2 Q8 reste exclu pour sa dérive sonore documentée. Kokoro apparaît avec une explication et un lien de
documentation, sans bouton Télécharger : les fiches amont ne décrivent pas complètement sa dépendance eSpeak.
Une nouvelle famille nécessite donc toujours de vérifier ses contraintes avant de l'activer dans Floppy.

Les métadonnées sont lues à un commit Hugging Face précis ; tous les fichiers d'un paquet doivent avoir
une taille et une empreinte LFS SHA-256 valides. Les chemins sont relatifs et validés. Pocket ne devient
disponible que si toutes les empreintes des voix offertes existent. Les licences sont celles du profil
du modèle, jamais la licence globale « other » du dépôt de conversions.

Le cache `tts-audiocpp/catalogue-<version>.json` dans `ctx.home` est écrit atomiquement et relu hors connexion.
Un échec laisse le catalogue précédent intact ; un JSON abîmé est mis de côté et signalé par le lecteur commun.
Les requêtes ont une limite globale de 45 s, partagent une seule actualisation simultanée et sont annulées à
l'arrêt du plugin. Un cache d'une autre version n'est pas réutilisé.

Chaque version de paquet a un identifiant et un sous-dossier dérivés des empreintes de ses fichiers. Les
réactualisations identiques sont idempotentes, les paquets identiques au catalogue livré ne sont pas dupliqués,
et les révisions précédentes restent dans la liste : aucune voix ou tâche de téléchargement en cours ne
change silencieusement de poids. L'étiquette de révision distingue les versions ; les estimations mémoire
des variantes GPU tiennent compte de leur taille réelle. Les anciens fichiers ne sont pas supprimés par
l'actualisation. Le cache est limité à 500 révisions ; atteindre cette limite conserve l'ancien catalogue
et signale l'échec d'actualisation.

Sources : [paquets et empreintes](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/73ce4162f6cce370dd533c6782b772135c1b2a8e),
[Voxtral](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/docs/models/voxtral_tts.md),
[Fish Audio](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/docs/models/fish_audio.md),
[Chatterbox](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/model_specs/chatterbox.json),
[VoxCPM2](https://github.com/0xShug0/audio.cpp/blob/v0.9.4/model_specs/voxcpm2.json).

**Programmes** : llama.cpp et audio.cpp se téléchargent aussi, dans la bonne version pour la machine (archives
décompressées par le noyau, `DownloadFile.extract`) : voir [Premier lancement](premier-lancement.md#télécharger-llamacpp-et-audiocpp-packagescoresrcprogram-libraryts).

## Pas encore

- Fichiers `mmproj` (vision) et modèles brouillons (MTP) du cerveau.
- Voix à cloner téléchargeables (WAV + texte) : les voix intégrées de Pocket TTS couvrent le besoin pour l'instant.
- Voix des services en ligne (Gemini, ElevenLabs) en liste.
