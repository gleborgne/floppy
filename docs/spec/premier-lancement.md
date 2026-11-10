# Premier lancement : régler Floppy selon la machine

Version 0.3 — 7 novembre 2026. Statut : implémenté (lecture de la machine, niveaux, fenêtre « Bienvenue », test de vitesse,
téléchargement de llama.cpp et audio.cpp dans la bonne version).

[← Spec](README.md)

## Pourquoi

Au premier lancement, l'utilisateur ne sait pas quels modèles sa machine peut faire tourner. Floppy lit la machine,
propose **le meilleur niveau qui tient dedans**, télécharge les modèles et règle les rôles (cerveau, écoute, voix).
Le plus simple : la transcription locale et un cerveau dans le cloud, réponses écrites. Le plus complet : tout en local.

## Ce que voit l'utilisateur

Fenêtre **« Bienvenue »**, ouverte seule au premier lancement (`floppy.yml` vient d'être créé), depuis Réglages →
Général → « Refaire le réglage de départ », et depuis le menu de l'icône (« Réglage de départ… »). 4 étapes :

1. **Ta machine** : « Je regarde ta machine… », puis un résumé : la puce graphique, le type de mémoire, la mémoire
   utilisable par les modèles, la RAM, la place libre sur le disque. Si rien n'est lu : choix manuel (« Pas de carte
   graphique », « 8 Go », « 12 Go », « 16 Go », « 24 Go et plus »). En dessous : le **dossier de Floppy** (son chemin,
   et « Changer… » : un sélecteur de dossiers ; Floppy repart dans ce dossier, voir [Le noyau → Le répertoire de
   travail](noyau.md#le-répertoire-de-travail)), puis les **programmes de cerveau** trouvés (Claude Code, Codex,
   Antigravity : « trouvé » ou « pas installé »).
2. **Le niveau** : une carte par niveau. Le niveau conseillé est mis en avant. Un niveau trop lourd reste visible avec
   la raison (« il manque 4 Go », « llama-server est introuvable ») ; on peut le forcer.
3. **Le cerveau dans le cloud**, seulement si le niveau en a besoin : les cerveaux cloud déjà offerts (grisés si leur
   programme est introuvable), puis les programmes trouvés pas encore dans la config (« sera ajouté »). Sans aucun :
   un mot vers Réglages → Cerveau.
4. **L'installation** : une ligne par modèle (barre d'avancement de la bibliothèque), puis le test de vitesse du cerveau
   local. À la fin : « Floppy est prêt. »

Fermer la fenêtre en cours de route : les téléchargements continuent ; la fenêtre revient au prochain démarrage tant
que le réglage n'est pas fini (`<home>/onboarding.json`, `done: false`). Bouton « Passer » : rien n'est changé, plus
de fenêtre au démarrage.

## Lire la machine (`packages/core/src/machine.ts`)

Ce fichier reste dans le noyau (`ctx.machine()` le lit) ; le premier lancement et les bibliothèques qui s'en servent sont dans `packages/setup`.

`probeMachine(opts)` rend un `MachineInfo`. Chaque sonde est facultative ; une sonde qui échoue est ignorée.
Les commandes passent par une fonction `run` injectable (tests : sorties simulées), avec 5 s au plus.

| Sonde | Système | Ce qu'elle donne |
|---|---|---|
| `nvidia-smi --query-gpu=name,memory.total,memory.free` | tous | NVIDIA : nom, mémoire totale et **libre** |
| `llama-server --list-devices` (si trouvé) | tous | les puces vues par llama.cpp (CUDA, Vulkan, Metal, ROCm, SYCL) et leur mémoire libre |
| `sysctl hw.memsize machdep.cpu.brand_string hw.optional.arm64` | mac | puce Apple : mémoire unifiée |
| registre `…\Class\{4d36e968-…}` (`DriverDesc`, `HardwareInformation.qwMemorySize`) | windows | nom et mémoire propre de chaque carte (WMI s'arrête à 4 Go : pas utilisé) |
| `/sys/class/drm/card*/device/` (`vendor`, `mem_info_vram_total`, `mem_info_gtt_total`) | linux | AMD et Intel : mémoire propre et partagée |
| indice de l'appli (`app.getGPUInfo`) | appli | fabricant (identifiant PCI) quand rien d'autre ne répond |
| `os.totalmem()`, `os.freemem()`, `fs.statfs()` | tous | RAM, place libre dans le dossier des modèles |

**Deux sortes de mémoire.**

- **Séparée** (carte NVIDIA, Radeon RX, Arc A/B) : la VRAM. Mémoire pour les modèles = la mémoire libre lue moins
  0,5 Go ; sans mémoire libre lue : la totale moins 15 % (au moins 1 Go) pour le bureau.
- **Unifiée** (Apple M, Ryzen AI, Intel Core Ultra, Snapdragon X) : la puce graphique partage la RAM.
  - Apple : la puce graphique a droit à environ 2/3 de la RAM (jusqu'à 36 Go), 3/4 au-delà ; et on laisse au moins
    8 Go au système. Mémoire pour les modèles = min(part, RAM − 8 Go).
  - PC : mémoire réservée par le BIOS (AMD Ryzen AI : lue comme mémoire propre) + mémoire partagée (Windows en donne
    la moitié de la RAM), sans prendre plus que RAM − 8 Go dans la part partagée. Chez Intel et Qualcomm, le registre
    annonce la part partagée possible (souvent plus de la moitié de la RAM) : elle n'est pas comptée en plus.
- **Aucune** : pas de puce graphique utile. Les modèles « processeur » restent possibles.

Une carte séparée l'emporte sur une puce intégrée. Si llama.cpp donne une mémoire libre plus juste, elle remplace
l'estimation. Les **moteurs** possibles sont notés par puce (NVIDIA : cuda, vulkan ; AMD : vulkan, rocm ; Intel :
vulkan, sycl ; Apple : metal ; Qualcomm : vulkan).

Le noyau garde le résultat (`kernel.machine()`, relu au plus toutes les 60 s). Les plugins le lisent par
`ctx.machine()`. Exemple : audio.cpp prend `backend: auto` par défaut : le moteur du programme téléchargé par Floppy
(cuda, vulkan, metal ou processeur), sinon cuda avec une carte NVIDIA, sinon le processeur. nvidia-smi donne aussi la
version du pilote (`GpuInfo.driver`), qui décide de la version de CUDA.

## Ce que demande chaque modèle

Une entrée de bibliothèque (`LibraryEntry`) peut dire :

- `service` : le service que rend son élément (« vad », « stt », « tts », « llm »), quand la bibliothèque en offre plusieurs ;
- `needs: { memory, device, backends? }` : la mémoire en octets ; `device` = « cpu » (RAM), « gpu » (mémoire des
  modèles) ; `backends` : les moteurs acceptés (Qwen3-TTS : cuda, vulkan, metal).

La bibliothèque dit aussi quel élément son modèle donne une fois installé (`itemOf`), et si son programme manque
(`missing` : « llama-server est introuvable »). La fenêtre les reçoit dans l'instantané du catalogue
(`ItemInfo.needs`, `ItemInfo.service`, `ItemInfo.uses`, `ProviderSnapshot.missing`).

## Télécharger llama.cpp et audio.cpp (`packages/setup/src/program-library.ts`)

Personne n'a à installer un programme à la main. Chaque plugin donne les archives figées d'une version
(`known-builds.ts`, généré depuis l'API GitHub, avec taille et sha256) : llama.cpp b12177, audio.cpp v0.9.4.
`programLibrary(ctx, …)` choisit l'archive qui va à la machine, la télécharge et la décompresse.

| Machine | llama.cpp | audio.cpp |
|---|---|---|
| windows + NVIDIA, pilote ≥ 580 | CUDA 13 + ses bibliothèques (≈ 600 Mo) | CUDA 13 + ses bibliothèques (≈ 850 Mo) |
| windows + NVIDIA, pilote ≥ 552 | CUDA 12 | CUDA 12 |
| windows + NVIDIA plus ancien, AMD, Intel | Vulkan | Vulkan |
| mac (puce Apple) | Metal | Metal |
| linux + puce graphique | Vulkan (pas les 600 Mo de CUDA) | Vulkan |
| sans puce | processeur | processeur |

- **Version « processeur » aussi proposée** : bien plus petite (25 à 32 Mo). L'onboarding la prend quand les modèles
  choisis tournent sur le processeur (voix Pocket TTS) ; une voix sur la puce graphique demande la version GPU
  (« Mettre à jour » si la petite est installée).
- **Décompression par le noyau** (`DownloadFile.extract`) : après la vérification sha256, les archives (.zip, .tar.gz)
  sont décompressées par le `tar` du système (celui de windows lit les .zip) dans un dossier temporaire, qui remplace
  le dossier final d'un coup ; les archives sont ensuite effacées. Un plugin ne lance pas lui-même de commande.
- **Rangement** : `<dossier des modèles>/<entrée>/programs/<version>/<archive>/`, et `programs/current.json`
  (version, archive et chemin du programme). Une nouvelle archive efface les anciennes (sauf un programme en marche :
  il partira au démarrage suivant).
- **Ordre de recherche du programme** : réglage « Programme llama-server » / « Programme audio.cpp », `exe` de la
  config, celui de Floppy, puis le PATH.
- **Fenêtre** : le programme est une ligne de la bibliothèque du rôle (Cerveau, Voix), avec sa taille, sa licence
  (MIT, Apache-2.0), et les boutons Télécharger, Annuler, Supprimer.
- **Onboarding** : un modèle dont le programme manque n'est plus bloqué si le programme se télécharge. Le programme
  devient une ligne de plus (rôle `program`), placée avant ses modèles ; il est prêt une fois installé (pas de slot).
- Vérifié sur une vraie machine (windows, RTX 4500) : versions processeur de llama.cpp et audio.cpp, et llama.cpp
  CUDA 13 (56 s ; `--list-devices` voit la carte).

## Secours, réparation, mises à jour des programmes

Floppy garde llama.cpp et audio.cpp en état de marche tout seul, même après l'onboarding. Le plugin dit à
`programLibrary` ce qui se passe ; la raison du changement (`ProgramChange`) lui dit s'il faut relancer les modèles en
marche (`restartsModels` : `upgrade`, `failover`, `repair`) ou attendre leur prochain lancement (`update`).

- **Monter en version** (`want("gpu")`) : la version « processeur » est installée (réglage de départ minimal) et un
  modèle demande la puce graphique (voix Qwen3-TTS ajoutée, voix choisie, cerveau local lancé). Floppy télécharge la
  meilleure archive pour la machine, en fond ; la version processeur sert en attendant ; puis les modèles en marche
  repartent avec la nouvelle (`ctx.restartOffers`). audio.cpp le vérifie au démarrage, à l'arrivée d'une voix et au
  lancement d'une voix ; llama.cpp au lancement d'un cerveau. Rien n'est fait si le moteur ou le programme est choisi
  à la main (`backend` autre que `auto`, réglage « Programme », `exe`).
- **Repli** (`failed`) : le programme ne démarre pas. Floppy le lance avec `--version` ; s'il ne se charge pas
  (bibliothèque absente, archive pour une autre machine, instruction inconnue du processeur : codes `0xC0000135`,
  `0xC000007B`, `0xC000001D`, `127`, signal `SIGILL`), l'archive est notée cassée sur cette machine
  (`programs/broken.json`) et la suivante se télécharge (CUDA 13 → CUDA 12 → Vulkan → processeur). Le message le
  dit (« … Floppy télécharge la version Vulkan, puis relance tout seul »). Un autre code de sortie veut dire que le
  programme a tourné : la panne vient d'ailleurs (modèle, port), rien n'est changé. « Télécharger » à la main redonne
  sa chance à une archive cassée.
- **Réparation** (au démarrage) : `current.json` existe mais le programme a disparu : la même archive se télécharge.
- **Mise à jour** (au démarrage) : une autre version est figée dans Floppy (`LLAMA_VERSION`, `AUDIOCPP_VERSION`) :
  la **même archive** (même moteur : la version processeur reste processeur, c'était un choix) dans la nouvelle
  version, en fond. L'ancienne sert jusqu'à la fin ; la nouvelle sert au prochain lancement du modèle.
- **Coupure réseau** : tout téléchargement (programmes et modèles) réessaie tout seul 3 fois (5 s, 30 s, 2 min), en
  reprenant où il en était ; la ligne affiche « nouvel essai 1 ». Pas de nouvel essai pour une adresse fausse
  (erreur 4xx sauf 408 et 429) ni pour une décompression ratée.

## Les programmes de cerveau (Claude Code, Codex, Antigravity)

Un plugin dit le programme dont il a besoin : `manifest.addable.program` (« claude », « codex », « agy »).
L'onboarding le cherche (`findExe`, `findAgents`) et sait s'il est déjà dans la config.

- Cerveau cloud déjà offert dont le programme manque : montré grisé, jamais conseillé.
- Programme trouvé, plugin pas encore ajouté : choix « add:<plugin> ». À l'installation, l'onboarding ajoute le plugin
  (opération `add` du fournisseur `apps-<rubrique>`, comme le bouton « Ajouter » des réglages), puis prend son premier
  élément offert.
- Cerveau conseillé : le premier cerveau offert dont le programme est là, sinon le premier programme trouvé à ajouter.
- Aucun : les niveaux cloud disent « installe Claude Code, Codex ou Antigravity, ou ajoute une clé ».

## Les niveaux (`packages/setup/src/onboarding.ts`, `planLevels`)

Le plan est calculé à partir des déclarations des plugins : aucun modèle n'est écrit en dur dans l'onboarding.
« Le meilleur » d'un rôle = l'entrée qui tient et qui demande le plus de mémoire (les petites sont moins bonnes).

| Niveau | Écoute | Voix | Cerveau |
|---|---|---|---|
| `texte` | VAD + transcription (processeur) | aucune (réponses écrites) | cloud |
| `voix` | idem | meilleure voix processeur | cloud |
| `hybride` | idem | meilleure voix sur la puce graphique | cloud |
| `local` | idem | meilleure voix processeur | meilleur modèle local qui tient |
| `local-max` | idem | meilleure voix sur la puce graphique | meilleur modèle local qui tient à côté |

- Un niveau est **possible** si chaque rôle a une entrée qui tient (mémoire des modèles pour « gpu », RAM − 6 Go
  pour « cpu »), avec un moteur accepté, un programme présent ou téléchargeable, et la place sur le disque (programmes
  compris). Sinon il porte la raison.
- **Conseillé** : le plus haut niveau possible. Sans cerveau cloud offert, les niveaux locaux passent devant.
- Une voix « gpu » et le cerveau partagent la mémoire des modèles : `local-max` additionne les deux.
- **Voix déjà offertes** (`offeredVoices`) : les voix du slot `voice.tts` hors cloud (ex. voix du système), sans
  téléchargement, comptées « processeur » avec 0 Go. Elles servent de repli quand aucune voix de bibliothèque ne peut
  tourner (audio.cpp introuvable) ; une voix de bibliothèque qui tient passe devant. Les voix d'un plugin dont le
  programme manque ne sont pas proposées.

## Appliquer un niveau (`Onboarding`)

**Personne n'attend les téléchargements.** Floppy marche tout de suite avec le minimum, puis chaque bloc s'active
dès qu'il est arrivé.

1. **Tout de suite** : `onboarding.json` = `{ done: false, level, brain }` (pour reprendre si Floppy est fermé en
   route). Voix « aucune » (`slot.voice.tts` = `@none`) tant que la voix n'est pas là. Cerveau cloud dans
   `slot.brain.main` s'il y en a un, même pour un niveau local (il répond en attendant le cerveau local) :
   `state.live = true`, « Floppy répond déjà par écrit, avec Claude ».
2. **Bloc par bloc** (`installSteps`) : l'écoute d'abord (détecteur de parole + Parakeet : Floppy entend vite), puis
   la voix, puis le cerveau local. Sans cerveau qui répond déjà, le cerveau passe avant la voix. Chaque bloc vient
   avec son programme (llama.cpp, audio.cpp). Un bloc à la fois : la bande passante va au plus utile.
3. Dans un bloc : modèle pas sur le disque : action `download` ; sur le disque mais absent de la liste : `use`.
   Prêt : `slot.<rôle>` = `<entrée>/<élément>` (via « ui »), et une phrase (« Floppy t'entend : tu peux lui parler »).
4. Le cerveau local passe d'abord le test de vitesse ; il ne prend la place du cerveau cloud que s'il est assez rapide.
5. Fin : `onboarding.json` = `{ done: true, level, at }`. Un bloc a échoué : phase `error`, Floppy marche avec le
   reste, et rien n'est marqué fini.
6. **Reprise** (`resume`, au démarrage) : `level` sans `done` = installation coupée ; elle repart (les blocs déjà
   téléchargés sont prêts tout de suite).

**Le choix reste à l'utilisateur** : le niveau conseillé est seulement présélectionné. Une grosse machine peut
prendre « Texte » ; la fenêtre le dit, et « Refaire le réglage de départ » permet de monter plus tard.

**Suivi** : l'avancement (`onboarding.state`) va à la fenêtre « Bienvenue » et à la rubrique Général des Réglages
(bloc « Installation de départ » : une ligne par morceau, %, prêt, échec, et les phrases de ce qui s'est activé).
La fenêtre « Bienvenue » peut se fermer : tout continue.

## Modèles déjà sur la machine (LM Studio, Ollama)

Le plugin llama.cpp lit les modèles déjà téléchargés par d'autres applis (`plugins/llm/llamacpp/src/found.ts`) :

- **LM Studio** : les `.gguf` de `~/.lmstudio/models` (et des dossiers du réglage). Un modèle en morceaux compte une fois.
- **Ollama** : chaque manifeste (`manifests/<hôte>/<espace>/<nom>/<étiquette>`) donne la couche `model`, un fichier
  GGUF dans `blobs/sha256-…` (dossier `OLLAMA_MODELS`, sinon `~/.ollama/models`). Le fichier doit commencer par
  « GGUF ». `ollama: false` dans la config coupe cette lecture.

llama.cpp les lance tels quels : rien à télécharger, LM Studio et Ollama n'ont pas besoin de tourner. Ils forment la
bibliothèque « Modèles déjà sur ta machine » (`llm-local-found`, taille 0, état « sur le disque ») ; `use` les
ajoute à la liste des cerveaux. Pour l'onboarding, un modèle déjà là et assez grand (≥ `MIN_LOCAL_BRAIN`) passe
devant un plus grand à télécharger. Un fichier que llama.cpp ne sait pas lire échoue au test de vitesse : le cerveau
cloud reste.

## Test de vitesse

Avant de brancher le cerveau local (le cerveau cloud répond pendant ce temps) : 2 courtes réponses (la 1re charge le modèle et n'est pas comptée), 48 mots-jetons
au plus, réflexion coupée. Vitesse = `timings.predicted_per_second` de llama-server, sinon jetons / durée.

- **≥ 15 jetons/s** : assez rapide pour parler (une phrase en moins d'une seconde).
- **Plus lent** : Floppy **descend tout seul** — modèle local plus petit qui tient (téléchargé puis testé à son tour),
  sinon le cerveau cloud choisi. La fenêtre le dit en une phrase (« Gemma 4 12B répondait à 8 jetons/s : Floppy prend
  Qwen3.5 4B »). Réglages permet de revenir en arrière.

Pourquoi un test et pas un tableau des puces : sur une mémoire unifiée, la vitesse dépend du débit de la mémoire
(≈ 120 Go/s pour un M4, plus de 500 Go/s pour un M4 Max, ≈ 1 000 Go/s pour une RTX 4090). Un modèle qui tient peut
être trop lent ; un tableau serait vite faux.

## Où c'est branché

- `apps/cli/src/boot.ts` : `firstRun` (config créée à ce démarrage, ou `onboarding.json` pas fini) et l'objet `onboarding`.
- `apps/desktop/src/kernel.ts` : messages `onboarding.get` (machine + niveaux), `onboarding.apply`, `onboarding.skip`,
  état poussé `onboarding.state`.
- `apps/desktop/src/app-windows.ts` (ouverture par `kernel-messages.ts` à `kernel.ready`, relais dans `ipc.ts`) : fenêtre `onboarding.html` (pont `preload-onboarding.cts`, compilé dans `build/`), ouverte à `kernel.ready`
  si `firstRun`, ou depuis les réglages.
- CLI : `floppy machine` montre ce que Floppy lit de la machine et les niveaux.

## Pas encore

- Qwen3-TTS sur Vulkan et Metal : permis, mais sa vitesse n'est pas mesurée (pas de test de vitesse pour la voix).
- Une archive GPU qui se charge mais ne voit pas la puce (pilote absent : llama.cpp passe alors sur le processeur
  sans le dire) : pas détectée. Piste : `llama-server --list-devices` après l'installation.
- Une voix ou un cerveau local qui tombe en panne en cours de route : le slot reste sur lui (pas de repli automatique
  sur la voix écrite ou le cerveau cloud).
- windows arm64 et linux arm64 pour audio.cpp : pas d'archive publiée ; le niveau dit qu'il manque le programme.
- Lire le débit de la mémoire pour prévoir la vitesse avant de télécharger.
- Serveurs d'Ollama et de LM Studio (API sur 11434 et 1234) : pas utilisés ; Floppy lit leurs fichiers à la place.
