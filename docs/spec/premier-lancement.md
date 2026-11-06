# Premier lancement : régler Floppy selon la machine

Version 0.1 — 6 novembre 2026. Statut : implémenté (lecture de la machine, niveaux, fenêtre « Bienvenue », test de vitesse).
À suivre : télécharger le bon llama.cpp et le bon audio.cpp selon la puce.

[← Spec](README.md)

## Pourquoi

Au premier lancement, l'utilisateur ne sait pas quels modèles sa machine peut faire tourner. Floppy lit la machine,
propose **le meilleur niveau qui tient dedans**, télécharge les modèles et règle les rôles (cerveau, écoute, voix).
Le plus simple : la transcription locale et un cerveau dans le cloud, réponses écrites. Le plus complet : tout en local.

## Ce que voit l'utilisateur

Fenêtre **« Bienvenue »**, ouverte seule au premier lancement (`floppy.yml` vient d'être créé), et depuis Réglages →
Général → « Refaire le réglage de départ ». 4 étapes :

1. **Ta machine** : « Je regarde ta machine… », puis un résumé : la puce graphique, le type de mémoire, la mémoire
   utilisable par les modèles, la RAM, la place libre sur le disque. Si rien n'est lu : choix manuel (« Pas de carte
   graphique », « 8 Go », « 12 Go », « 16 Go », « 24 Go et plus »).
2. **Le niveau** : une carte par niveau. Le niveau conseillé est mis en avant. Un niveau trop lourd reste visible avec
   la raison (« il manque 4 Go », « llama-server est introuvable ») ; on peut le forcer.
3. **Le cerveau dans le cloud**, seulement si le niveau en a besoin : les cerveaux cloud déjà offerts (Claude, Codex,
   modèles distants). Sans aucun : un mot vers Réglages → Cerveau.
4. **L'installation** : une ligne par modèle (barre d'avancement de la bibliothèque), puis le test de vitesse du cerveau
   local. À la fin : « Floppy est prêt. »

Fermer la fenêtre en cours de route : les téléchargements continuent ; la fenêtre revient au prochain démarrage tant
que le réglage n'est pas fini (`<home>/onboarding.json`, `done: false`). Bouton « Passer » : rien n'est changé, plus
de fenêtre au démarrage.

## Lire la machine (`packages/core/src/machine.ts`)

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
  - PC : mémoire réservée par le BIOS (lue comme mémoire propre) + mémoire partagée (Windows en donne la moitié de
    la RAM), sans prendre plus que RAM − 8 Go dans la part partagée.
- **Aucune** : pas de puce graphique utile. Les modèles « processeur » restent possibles.

Une carte séparée l'emporte sur une puce intégrée. Si llama.cpp donne une mémoire libre plus juste, elle remplace
l'estimation. Les **moteurs** possibles sont notés par puce (NVIDIA : cuda, vulkan ; AMD : vulkan, rocm ; Intel :
vulkan, sycl ; Apple : metal ; Qualcomm : vulkan).

Le noyau garde le résultat (`kernel.machine()`, relu au plus toutes les 60 s). Les plugins le lisent par
`ctx.machine()`. Exemple : audio.cpp prend `backend: auto` par défaut, soit cuda avec une carte NVIDIA, sinon le
processeur.

## Ce que demande chaque modèle

Une entrée de bibliothèque (`LibraryEntry`) peut dire :

- `service` : le service que rend son élément (« vad », « stt », « tts », « llm »), quand la bibliothèque en offre plusieurs ;
- `needs: { memory, device, backends? }` : la mémoire en octets ; `device` = « cpu » (RAM), « gpu » (mémoire des
  modèles) ; `backends` : les moteurs acceptés (Qwen3-TTS : cuda seulement).

La bibliothèque dit aussi quel élément son modèle donne une fois installé (`itemOf`), et si son programme manque
(`missing` : « llama-server est introuvable »). La fenêtre les reçoit dans l'instantané du catalogue
(`ItemInfo.needs`, `ItemInfo.service`, `ItemInfo.uses`, `ProviderSnapshot.missing`).

## Les niveaux (`packages/core/src/onboarding.ts`, `planLevels`)

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
  pour « cpu »), avec un moteur accepté, un programme présent, et la place sur le disque. Sinon il porte la raison.
- **Conseillé** : le plus haut niveau possible. Sans cerveau cloud offert, les niveaux locaux passent devant.
- Une voix « gpu » et le cerveau partagent la mémoire des modèles : `local-max` additionne les deux.

## Appliquer un niveau (`Onboarding`)

1. Chaque modèle choisi pas encore sur le disque : action `download` de sa bibliothèque (la file du noyau).
2. Modèle sur le disque mais absent de la liste : action `use`.
3. Élément présent : réglage `slot.<rôle>` = `<entrée>/<élément>` (via « ui » : même chemin que la fenêtre).
4. Voix « aucune » : `slot.voice.tts` = `@none`. Le slot `voice.tts` a désormais un choix « Aucune (réponses
   écrites) » ; sans choix, le premier élément reste pris (`SlotDef.defaultFirst`). La conversation ne parle pas et
   ne montre pas d'erreur.
5. Cerveau cloud : `slot.brain.main` = le choix de l'étape 3.
6. Fin : `onboarding.json` = `{ done: true, level, at }`.

L'avancement est poussé à la fenêtre (`onboarding.state`) : une ligne par modèle (attente, %, prêt, échec).

## Test de vitesse

Après le réglage du cerveau local : 2 courtes réponses (la 1re charge le modèle et n'est pas comptée), 48 mots-jetons
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
- `apps/desktop/src/main.mjs` : fenêtre `onboarding.html` (pont `preload-onboarding.cjs`), ouverte à `kernel.ready`
  si `firstRun`, ou depuis les réglages.
- CLI : `floppy machine` montre ce que Floppy lit de la machine et les niveaux.

## Pas encore

- Télécharger llama.cpp et audio.cpp dans la bonne version (cuda, vulkan, metal) : aujourd'hui l'onboarding dit
  seulement qu'il manque le programme.
- audio.cpp sur Metal ou Vulkan : les voix « carte graphique » restent pour NVIDIA.
- Lire le débit de la mémoire pour prévoir la vitesse avant de télécharger.
