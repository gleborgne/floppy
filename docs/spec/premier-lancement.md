# Premier lancement : régler Floppy selon la machine

Version 0.4 — 10 novembre 2026. Statut : données et logique implémentées (lecture de la machine, un choix de modèle par
rôle avec un conseil selon la machine et la langue, écoute en avance, test de vitesse, téléchargement de llama.cpp et
audio.cpp dans la bonne version). La fenêtre « Bienvenue » suit : elle montre encore les anciens niveaux tant qu'elle n'est
pas refaite.

[← Spec](README.md)

## Pourquoi

Au premier lancement, l'utilisateur ne sait pas quels modèles sa machine peut faire tourner, ni lesquels parlent bien sa
langue. Floppy lit la machine et la langue de l'assistant, et propose **pour chaque rôle (cerveau, écoute, voix) un vrai
modèle** : le **conseillé** est le meilleur qui tient dans la machine, noté pour la langue. L'utilisateur peut en prendre un
autre. Floppy télécharge, règle les rôles, et marche tout de suite avec le minimum.

## Ce que voit l'utilisateur

Fenêtre **« Bienvenue »** (960 x 680), ouverte seule au premier lancement (`floppy.yml` vient d'être créé), depuis Réglages →
Général → « Refaire le réglage de départ », et depuis le menu de l'icône (« Réglage de départ… »). Floppy y parle à la
première personne. Disposition commune : à gauche, sa bulle, son visage (l'aperçu fixe de l'avatar affiché, sinon des
anneaux ; jamais de WebGL) et la liste des quatre morceaux (cerveau, oreilles, voix, outils) qui se cochent avec la valeur
choisie ; à droite, le titre, une phrase, les choix, et le pied (Retour / Continuer). Six écrans : bonjour, quatre
questions, installation. Le conseil du plan (`plan.recommended`) est présélectionné partout ; tout est modifiable plus tard
dans les Réglages. Les textes sont dans `renderer/onboarding-i18n.ts` (fr / en), les règles sans DOM dans
`onboarding-view.ts` et `onboarding-summary.ts` (testées), la page dans `onboarding.ts` et ses modules `onboarding-*.ts`.

1. **Bonjour** : la **langue de l'assistant** (« Changer… » : Français / English, par `setLanguage` : même chemin que les
   Réglages, le plan est recalculé et la fenêtre prend cette langue), la machine **en une phrase** (« assez costaude pour
   que je fonctionne en entier chez toi », « un peu juste pour mon cerveau : je réfléchirai en ligne », « un peu juste »,
   ou rien de lu) avec « Voir le détail » (puce, mémoire, RAM, place libre, « Relire la machine », programmes de cerveau
   trouvés : Claude Code, Codex, Antigravity) et le **dossier de Floppy** (« Changer… » : un sélecteur de dossiers ; Floppy
   repart dans ce dossier, voir [Le noyau → Le répertoire de travail](noyau.md#le-répertoire-de-travail)). Si rien n'a pu
   être lu : le choix manuel de la mémoire (« Pas de carte », 8, 12, 16, 24 Go) s'ouvre tout de suite. Dès que le plan est lu,
   la fenêtre appelle `prepareListening()` (une fois) : l'écoute se télécharge pendant les questions.
2. **Cerveau** : « Chez toi » (choix `kind: "local"`) ou « En ligne » (`kind: "cloud"`, dont les programmes trouvés à ajouter) ;
   l'onglet ouvert au départ est celui du conseil. Une ligne par modèle : nom, « Recommandé », « Déjà sur ton ordinateur »
   ou la taille à télécharger (`size`, programme compris), l'étiquette de langue (`languageNote` : grise, ou jaune si la
   langue est mal gérée). Un modèle qui ne tient pas est grisé avec sa raison et « Essayer quand même ». Sans cerveau en ligne
   prêt : un mot et « Ouvrir les réglages ». Il n'y a pas de note « malin / rapide » dans les données : elle n'est pas montrée.
3. **Oreilles** : le modèle de transcription choisi (« Changer de modèle » ouvre la même liste que les autres écrans), puis les
   **façons d'appeler** Floppy, branchées sur de vrais réglages par le chemin des Réglages : « En disant mon nom » (slot
   `listen.wakeword` : `@none` = éteint ; l'allumer remet l'entrée active ou la première offerte) et « Avec un raccourci du
   clavier » (réglage `raccourci_parler`, vide = désactivé ; écrit `Ctrl+Alt+…`, `⌃⌥…` sur Mac). Un réglage absent : la ligne
   n'est pas montrée. **Essai du micro** : des barres de niveau mesurées dans la fenêtre (`getUserMedia` et `AnalyserNode`),
   sans rien enregistrer ni envoyer ; le flux est arrêté en quittant l'écran ; avec « mouvement réduit », quelques mises à
   jour par seconde et pas de fondu. Pas de transcription dans cette version : le texte dit que le micro marche. Tant que
   l'écoute n'est pas téléchargée, une barre d'avancement (lignes `vad` et `stt` de l'état) dit qu'on peut continuer.
4. **Voix** : la liste des modèles de voix, un bouton rond « écouter » seulement si le choix a un `sample` (un seul son à la
   fois, joué dans la fenêtre : la CSP n'autorise `media-src` qu'en http(s)), l'étiquette de langue, « Pas de voix (réponses
   écrites) » en dernier.
5. **Outils** : les connecteurs déjà ajoutés à Floppy (fournisseur `apps-connecteurs`), chacun avec un interrupteur qui
   fait l'opération `enable` du catalogue, comme les Réglages ; sans connecteur : un mot et « Ouvrir les réglages ». Un
   encadré rappelle que Floppy demande toujours avant d'envoyer, de modifier ou de supprimer. « Terminer » envoie la
   sélection (`apply({ brain, stt, tts })`).
6. **Installation** : une ligne par morceau, regroupées depuis les lignes de l'état : *oreilles* (détecteur de parole,
   transcription et leur programme), *voix*, *cerveau* (programme, modèle, et le plus petit modèle pris après un test de
   vitesse trop lent), avec la barre d'avancement (moyenne des lignes), la phrase du morceau (« En attendant, je réponds par
   écrit », « je réfléchis en ligne » quand un cerveau en ligne répond déjà), les notes du noyau, le test de vitesse et la fin.
   En cas d'échec : « Revenir aux choix ». Fenêtre rouverte pendant une installation : on revient sur cet écran.

L'état de l'installation (`onboarding.state`) va aussi aux Réglages (Général), qui lisent `installSummary` et `rowStatus`
de `onboarding-view.ts`. Fermer la fenêtre en cours de route : les téléchargements continuent ; la fenêtre revient au
prochain démarrage tant que le réglage n'est pas fini (`<home>/onboarding.json`, `done: false`). Bouton « Passer, je
réglerai plus tard » : rien n'est changé, plus de fenêtre au démarrage.

Passage par l'application : `preload-onboarding.cts` expose `plan`, `setLanguage`, `prepareListening`, `extras` (façons
d'appeler et connecteurs), `setWay`, `setTool`, `apply`, `skip`… ; `ipc.ts` borne les chaînes et ne répond qu'à cette fenêtre ;
`kernel.ts` appelle `Onboarding` et le catalogue (`onboarding-extras.ts` : règles pures, testées). Le micro n'est permis qu'à
l'avatar, aux Réglages et à cette fenêtre.

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
  modèles) ; `backends` : les moteurs acceptés (Qwen3-TTS : cuda, vulkan, metal) ;
- `languages` : sa note par langue (`LanguageSupport` : `{ fr: "good", en: "fair" }`, niveaux `good` / `fair` / `poor`,
  langue absente = inconnue), pour la transcription et les voix. Elle ne s'écrit que si le dépôt ou la fiche publique du
  modèle le dit (voir [Téléchargements](telechargements.md)) ; les voix déjà offertes (système) et les cerveaux n'en ont pas ;
- `sample` : un court extrait sonore à écouter avant de choisir.

La bibliothèque dit aussi quel élément son modèle donne une fois installé (`itemOf`), et si son programme manque
(`missing` : « llama-server est introuvable »). La fenêtre les reçoit dans l'instantané du catalogue
(`ItemInfo.needs`, `ItemInfo.languages`, `ItemInfo.sample`, `ItemInfo.service`, `ItemInfo.uses`, `ProviderSnapshot.missing`).

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
- Cerveau cloud utilisable (`Plan.brain`) : le premier cerveau offert dont le programme est là, sinon le premier programme trouvé à ajouter. Il répond en attendant un cerveau local.
- Aucun : pas de cerveau conseillé ni de cloud à prendre ; la fenêtre dit « installe Claude Code, Codex ou Antigravity, ou ajoute une clé ».

## Les choix par rôle (`packages/setup/src/onboarding.ts`, `planChoices`)

Le plan est calculé à partir des déclarations des plugins : aucun modèle n'est écrit en dur dans l'onboarding.
`Plan.choices` donne, pour `brain`, `stt` et `tts`, la liste des `Choice` ; `Plan.recommended` (une `Selection`) donne le
conseil ; `Plan.language` la langue pour laquelle il est calculé (code à 2 lettres, lu dans `assistant.language`).

| Champ de `Choice` | Sens |
|---|---|
| `value` | ce qu'on renvoie dans `Selection` : `<fournisseur>/<id>` (modèle de bibliothèque), `<entrée>/<élément>` (voix déjà offerte), la valeur du slot (cerveau cloud), `add:<plugin>`, `@none` |
| `kind` | `local` (modèle de bibliothèque), `cloud` (cerveau cloud ou `add:<plugin>`), `offered` (voix déjà offerte), `none` (pas de voix) |
| `fits`, `reason` | tient dans la machine (l'écoute est déjà réservée), sinon pourquoi |
| `installed`, `size` | déjà sur la machine ; octets à télécharger, programme compris (llama.cpp, audio.cpp) |
| `device` | `cpu` ou `gpu` |
| `language` | note pour la langue de l'assistant ; absent : inconnue |
| `sample`, `description` | extrait sonore, description du modèle |
| `recommended` | le conseil de ce rôle (au plus un par rôle) |

Un modèle **tient** si sa mémoire entre dans ce qui reste (mémoire des modèles pour « gpu », RAM − 6 Go pour « cpu »),
avec un moteur accepté, un programme présent ou téléchargeable, et la place sur le disque (modèle et programme). Les choix
qui tiennent passent avant les autres, le conseillé en tête.

**Le conseil.**

- **Écoute** (détecteur de parole, puis transcription) : réservée en premier. Transcription conseillée : parmi celles qui
  tiennent, la meilleure note pour la langue (`good` avant `fair` avant langue **inconnue** avant `poor`), puis le plus gros
  qui tient, installé d'abord. Un modèle `poor` n'est conseillé que s'il n'y a rien d'autre.
- **Voix** : même règle, sur ce qui reste après l'écoute. Voix de bibliothèque et voix déjà offertes se classent ensemble
  (une voix du système, sans note, passe devant une voix notée `poor`, et derrière une voix notée `good`). Rien ne tient :
  « Pas de voix » est le conseil.
- **Cerveau**, dans ce qui reste après l'écoute et la voix : un modèle local si un d'au moins `MIN_LOCAL_BRAIN` (6 Go)
  tient (un modèle déjà sur la machine, assez grand, passe devant un plus grand à télécharger) ; sinon un cerveau cloud
  utilisable ; sans cloud, le plus grand local qui tient, même petit.
- **Ensemble** : processeur et puce graphique prennent dans la même RAM sur une mémoire unifiée, et une voix sur la puce
  graphique partage la mémoire des modèles avec le cerveau local. La voix conseillée est la mieux classée qui laisse
  encore un cerveau ; sinon, la mieux classée seule. Les trois conseillés tiennent donc ensemble.

Changer la langue (`Onboarding.setLanguage`) passe par le réglage `langue_assistant`, comme dans les Réglages (les plugins
redémarrent), puis recalcule le plan.

- **Voix déjà offertes** (`offeredVoices`) : les voix du slot `voice.tts` hors cloud (ex. voix du système), sans
  téléchargement, comptées « processeur » avec 0 Go (`kind: "offered"`). Elles servent de repli quand aucune voix de
  bibliothèque ne peut tourner (audio.cpp introuvable) et restent un choix sinon. Les voix d'un plugin dont le programme
  manque ne sont pas proposées.

## Appliquer une sélection (`Onboarding`)

`apply(selection)` prend la `value` d'un choix par rôle (`Selection { brain?, stt?, tts? }`, souvent `plan.recommended`).
Un rôle absent n'est pas touché (la voix absente vaut « pas de voix »). Une valeur qui n'est pas dans le plan : refusée.
Un choix qui ne tient pas est permis (forcé).

**Personne n'attend les téléchargements.** Floppy marche tout de suite avec le minimum, puis chaque bloc s'active
dès qu'il est arrivé.

1. **Tout de suite** : `onboarding.json` = `{ done: false, selection }` (pour reprendre si Floppy est fermé en
   route). Voix « aucune » (`slot.voice.tts` = `@none`) tant que la voix n'est pas là. Cerveau cloud dans
   `slot.brain.main` s'il y en a un (le choisi, ou `Plan.brain` quand le cerveau choisi est local), il répond en attendant le
   cerveau local : `state.live = true`, « Floppy répond déjà par écrit, avec Claude ».
2. **Bloc par bloc** (`installSteps`) : l'écoute d'abord (détecteur de parole + transcription : Floppy entend vite), puis
   la voix, puis le cerveau local. Sans cerveau qui répond déjà, le cerveau passe avant la voix. Chaque bloc
   vient avec son programme (llama.cpp, audio.cpp). Un bloc à la fois : la bande passante va au plus utile.
3. Dans un bloc : modèle pas sur le disque : action `download` ; sur le disque mais absent de la liste : `use`.
   Prêt : `slot.<rôle>` = `<entrée>/<élément>` (via « ui »), et une phrase (« Floppy t'entend : tu peux lui parler »).
4. Le cerveau local passe d'abord le test de vitesse ; il ne prend la place du cerveau cloud que s'il est assez rapide.
5. Fin : `onboarding.json` = `{ done: true, selection, at }`. Un bloc a échoué : phase `error`, Floppy marche avec le
   reste, et rien n'est marqué fini.
6. **Reprise** (`resume`, au démarrage) : `selection` sans `done` = installation coupée ; elle repart (les blocs déjà
   téléchargés sont prêts tout de suite). Un fichier sans `selection` (ancien format, voir la migration) n'est pas repris :
   la fenêtre revient.

**Écoute en avance** (`prepareListening`). Écouter est le premier besoin, et la transcription conseillée est presque toujours
gardée : dès que le plan est lu, la fenêtre appelle `prepareListening()`, qui télécharge tout de suite le détecteur de parole
et la transcription conseillée (avec leur programme) et règle leurs slots (`listen.vad`, `listen.stt`) quand ils sont prêts.
Les lignes d'avancement sont dans `OnboardingState.rows` comme les autres (phase `idle`). Sans effet la seconde fois.
`apply` ne retélécharge rien de ce qui est déjà là ou en cours : il attend le même téléchargement. Si l'utilisateur choisit
une **autre** transcription, c'est elle qui prend le slot ; la première, déjà demandée, finit son téléchargement (sa ligne
reste) sans toucher au slot. Un changement de langue après le lancement ne relance pas d'autre téléchargement.

**Le choix reste à l'utilisateur** : le conseillé est seulement présélectionné. « Refaire le réglage de départ » permet de
changer plus tard.

**Suivi** : l'avancement (`onboarding.state` : `phase`, `selection`, `rows`, `notes`, `speed`, `live`) va à la fenêtre
« Bienvenue » et à la rubrique Général des Réglages (bloc « Installation de départ » : une ligne par morceau, %, prêt,
échec, et les phrases de ce qui s'est activé). La fenêtre « Bienvenue » peut se fermer : tout continue.

**Anciens fichiers.** Les niveaux (`level`, avec `brain` à côté) n'existent plus. La migration du dossier
`onboarding-selection` ([noyau](noyau.md)) retire ces deux clés d'`onboarding.json` ; il n'y a pas de lecture des anciens
noms. Une installation qui était coupée n'est pas reprise toute seule (aucune sélection n'en découle sans relire la machine) :
la fenêtre « Bienvenue » revient.

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
- `apps/desktop/src/kernel.ts` : messages `onboarding.get` (machine + choix + conseil), `onboarding.apply` (une
  `Selection`), `onboarding.skip`, état poussé `onboarding.state`. À brancher (fenêtre refaite) : `prepareListening` et
  `setLanguage`.
- `apps/desktop/src/app-windows.ts` (ouverture par `kernel-messages.ts` à `kernel.ready`, relais dans `ipc.ts`) : fenêtre `onboarding.html` (pont `preload-onboarding.cts`, compilé dans `build/`), ouverte à `kernel.ready`
  si `firstRun`, ou depuis les réglages.
- CLI : `floppy machine` montre ce que Floppy lit de la machine, la langue, et les choix par rôle (★ conseillé, ✖ ne tient pas).

## Pas encore

- Qwen3-TTS sur Vulkan et Metal : permis, mais sa vitesse n'est pas mesurée (pas de test de vitesse pour la voix).
- Une archive GPU qui se charge mais ne voit pas la puce (pilote absent : llama.cpp passe alors sur le processeur
  sans le dire) : pas détectée. Piste : `llama-server --list-devices` après l'installation.
- Une voix ou un cerveau local qui tombe en panne en cours de route : le slot reste sur lui (pas de repli automatique
  sur la voix écrite ou le cerveau cloud).
- windows arm64 et linux arm64 pour audio.cpp : pas d'archive publiée ; le choix dit qu'il manque le programme.
- Lire le débit de la mémoire pour prévoir la vitesse avant de télécharger.
- Serveurs d'Ollama et de LM Studio (API sur 11434 et 1234) : pas utilisés ; Floppy lit leurs fichiers à la place.
