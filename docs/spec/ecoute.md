# Écoute en plugins : détecteur de parole, transcription, plugin « Écoute »

Version 0.1 — 6 novembre 2026. Statut : en cours (contrats, plugin Écoute et lecteur sherpa-onnx implémentés ; audio.cpp et retrait de Python à suivre).

[← Spec](README.md)

## Pourquoi

Le service Python (`services/voice`, plugin `voice-cascade`) fait tout d'un bloc : détecter la parole (Silero),
découper les phrases, transcrire (Parakeet), interrompre, recoller, dictée, et parler. On ne peut changer aucun morceau
sans changer le bloc. But : **chaque morceau est un plugin**, les modèles sont des éléments de catalogue de leur
« lecteur » (comme llama.cpp et audio.cpp), et à terme **plus de Python** (la voix passe déjà par les plugins `tts`).

## Découpage

| Rôle | Contrat | Fourni par | Choisi dans |
|---|---|---|---|
| Repérer la parole (VAD) | `vad` | un lecteur (sherpa-onnx : Silero) | slot `listen.vad` |
| Transcrire un morceau de son | `stt` | un lecteur (sherpa-onnx : Parakeet ; audio.cpp, transcribe.cpp plus tard) | slot `listen.stt` |
| Règles d'écoute + flux par corps | `voice` (inchangé) | plugin **Écoute** (`voice-listen`) | — |
| Parler | `tts` | plugins `tts-*` | slot `voice.tts` |

Dans les réglages, les trois slots de la rubrique Écoute portent un `step` (VAD 1, STT 2, mot d'activation 3) : la
fenêtre les montre en chaîne, « parole → texte → réveil ». Le mot d'activation « Dans le texte transcrit » (`wakeword-stt`)
ne coûte rien de plus : il lit le texte de chaque phrase que le VAD a laissé passer vers la transcription. Ses mots se
modifient dans son onglet ; « Dernier réveil » montre la phrase qui a réveillé Floppy (gardée en mémoire seulement).

La conversation ne change pas : elle parle toujours au contrat `voice`. Le service Python reste un autre fournisseur
du même contrat le temps de la transition. Les deux ne doivent pas être configurés ensemble (le premier actif gagne).

## Contrats (packages/contracts/src/voice.ts)

Tout le son est en float32 mono 16 kHz.

```ts
interface VadService {
  name: string;
  /** Silence attendu avant la fin d'une phrase (compté dans la latence perçue). */
  minSilenceMs: number;
  open(): VadStream;                       // un détecteur par corps (il a un état)
}
interface VadStream {
  /** Blocs de toute taille, dans l'ordre. Rend les débuts et fins détectés ; sample = index dans ce flux. */
  push(frame: Float32Array): VadEvent[];
  reset(): void;
  close(): void;
}
type VadEvent = { type: "start" | "end"; sample: number };

interface SttService {
  name: string;
  /** Langues connues du modèle (« fr », « en »…). Absent : inconnu. */
  languages?: string[];
  transcribe(audio: Float32Array, opts: { language?: string; signal?: AbortSignal }): Promise<{ text: string }>;
}
```

`VoiceStream.speak` devient facultatif : le plugin Écoute ne parle pas. La file de parole de la conversation parle par
`tts.speak()` ; une voix `viaStream` (voix locales Python) avec un flux sans `speak` est signalée indisponible.

## Plugin Écoute (`plugins/voice/listen`)

- Fournit `voice`. Déclare les slots `listen.vad` et `listen.stt` (rubrique Écoute).
- Les modèles ne tournent pas pour rien : le VAD et le STT sont **empruntés** (`ctx.borrow`) à l'ouverture du premier
  flux, et rendus quand le dernier flux se ferme. Un changement de choix vaut pour les flux ouverts ensuite.
- Un flux par corps : son propre détecteur (`vad.open()`), le STT est partagé et appelé **une phrase à la fois**.
- Règles reprises du service Python, à l'identique :
  - trames de 512 échantillons (32 ms) ; 10 trames gardées avant le début (pré-roll) ;
  - phrase de moins de 0,3 s : ignorée ;
  - **interruption** (`barge_in`) : 300 ms de parole continue pendant que la voix joue (`setSpeaking(true)`), une fois (réarmé par `setSpeaking`). La conversation baisse alors la voix et attend le texte reconnu pour distinguer l'utilisateur de l'écho (voir fonctionnement.md, point 8) ;
  - **recollage** (`merge`) : reprise moins de 2 s après la fin, sans réponse parlée entre-temps, si autorisé
    (`setMergeEnabled`) : la phrase précédente est remise devant, `merged: true` ;
  - **fin de phrase adaptative** : si le texte a l'air inachevé (`looksUnfinished` : fin sur « … », « , », une hésitation
    « euh / uh », ou un mot de liaison « et, de, à / and, to, the » sans ponctuation finale ; jamais un mot seul comme
    « oui » ou « stop »), le `transcript` est **retenu** `hold_incomplete_ms` (réglage de la rubrique Écoute, 1200 ms,
    0 = désactivé). Une reprise de parole pendant l'attente recolle l'audio (`merge`) et le texte retenu n'est jamais
    émis ; sinon il part à la fin du délai, `silence_ms` rallongé de l'attente. Jamais retenu : bouton, dictée, voix qui
    joue (l'interruption reste immédiate), recollage coupé. Fermeture : le texte retenu est abandonné, minuteur nettoyé ;
  - **bouton** (`ptt`) : le VAD est ignoré ; tout le son entre l'appui et le relâché est une phrase (`silence_ms: 0`) ;
  - **dictée** : segments coupés aux pauses ou à 30 s ; une hypothèse toutes les 0,6 s de parole (jamais deux en même
    temps), puis la version finale ; pas de `transcript` ;
  - `transcript` porte `audio_s`, `stt_ms`, `merged`, `utt`, `start_sample`, `end_sample` (horloge du flux),
    `silence_ms` (= `minSilenceMs` du VAD).

## Lecteur sherpa-onnx (`plugins/stt/sherpa`)

- Bibliothèque `sherpa-onnx-node` (déjà utilisée par le mot d'activation Sherpa), dans le processus, sur le processeur.
- Offre `vad` et `stt` élément par élément. Catalogue (rubrique Écoute) : on ajoute un **modèle** par son dossier ou
  son fichier ; le type est reconnu aux fichiers présents :
  - VAD Silero : un fichier `.onnx` (ex. `silero_vad.onnx`) ;
  - transducteur NeMo (Parakeet TDT) : un dossier avec `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt`.
- Un élément ne sert qu'au service qui correspond à son type. Le modèle est chargé dans le fork, libéré avec lui.
- Détecteur : `isDetected()` lu après chaque trame ; un changement donne `start` ou `end`. `minSpeechDuration` 0,1 s.
  Le début arrive environ 0,3 s après la vraie attaque : le pré-roll de 10 trames (0,32 s) du plugin Écoute le couvre.
- Le type de transducteur (NeMo, Zipformer…) est lu dans le modèle par la bibliothèque (`modelType` vide).
- Mesures (6 novembre 2026, processeur, Parakeet TDT v3 int8, 2 fils) : chargement 1,5 s ; 5,8 s de parole -> 150 ms ;
  13 s -> 320 ms. Au-delà d'une minute, Parakeet dérive vers l'anglais (sans effet sur les phrases de conversation).
- Essai réel : `FLOPPY_TEST_SHERPA=<dossier>` (silero_vad.onnx + dossier Parakeet avec test_wavs/fr.wav).

## Suite

Le vocabulaire personnel est désormais un plugin séparé (`voice/vocabulary`) qui utilise la mémoire, après acceptation d'une demande utilisateur. Il apprend les corrections explicites de noms (ex. Core Team) et fournit des interprétations contextualisées aux cerveaux. Le contrat STT et le son restent inchangés ; aucun remplacement global des transcriptions ni de la dictée. Voir [Mémoire et corrections](memoire-skills-ton-langue.md#corrections-du-vocabulaire-implémenté).

1. Lecteur audio.cpp : offrir aussi `stt` (familles `*_asr`, dont `parakeet_tdt`) et `vad`, un seul serveur partagé.
2. Lecteur transcribe.cpp (Parakeet Ultra, Silero intégré).
3. « Modèles connus » à ajouter en un clic : **fait** (Silero VAD, Parakeet TDT v3), voir [telechargements.md](telechargements.md).
4. Voix locales sans Python : **fait** pour le processeur avec audio.cpp — Pocket TTS (voix clonée, en flux, 1er son ~50 ms)
   et Supertonic 3 (familles `pocket_tts`, `supertonic`). Kokoro écarté : eSpeak-ng (GPL) requis en français ;
   sherpa-onnx 2 l'a retiré, audio.cpp 0.9.4 ne charge pas la DLL fournie (cause non trouvée).
5. Retrait de `services/voice` et `voice-cascade` (archivés, pas supprimés).
