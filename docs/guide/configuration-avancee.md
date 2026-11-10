# Configuration avancée : voix cloud, Live et mot d'activation

[← Guides](README.md)

## Voix cloud et conversations Live

Les quatre fournisseurs sont présents dans `floppy.yml`, sans être sélectionnés par défaut.
Dans **Réglages → Voix**, ouvrir le formulaire Gemini TTS ou ElevenLabs TTS pour enregistrer la clé,
le modèle et la voix (pour ElevenLabs : l'identifiant de voix du compte). Choisir ensuite **Fournisseur TTS**.
Le cerveau habituel conserve le raisonnement ; seule la synthèse change. Le TTS local est libéré pendant l'usage d'un autre fournisseur.

Dans **Réglages → Cerveau**, configurer Gemini Live ou GPT Live, puis choisir **Mode de conversation**.
Le modèle Live utilise sa voix native : le choix du TTS de la cascade ne la remplace pas.
Changer « Voix de la cascade » pendant le mode Live est refusé avec cette explication.
Les choix locaux et ceux de chaque TTS sont conservés séparément. Un fournisseur sans clé ou sans voix requise
ne peut pas être sélectionné depuis les réglages.
Les clés sont cloisonnées par plugin dans le coffre de l'OS ; elles ne sont jamais écrites dans le YAML.
Une clé Google doit donc être renseignée séparément pour Gemini TTS et Gemini Live.

### Floppy sans carte graphique

Tout tourne sur le processeur (mesures du 6 novembre 2026, 4 fils) :

| Rôle | Plugin et modèle | Mesure |
|---|---|---|
| Repérer la parole | Écoute + sherpa-onnx, Silero VAD | — |
| Transcrire | sherpa-onnx, Parakeet TDT v3 int8 | phrase de 6 s : ~150 ms |
| Parler | audio.cpp (`backend: cpu`), **Pocket TTS français**, voix de Floppy clonée | 1er son ~50 ms (0,8 s au réveil) ; 3× plus vite que la parole |
| Cerveau | Claude Code ou Codex (montage B), ou une API | le modèle local du montage A demande une carte graphique |

Pocket TTS : `PocketTTS-GGUF/french/pocket-tts-french-q8_0.gguf` du dépôt Hugging Face `audio-cpp/audio.cpp-gguf` (128 Mo),
famille `pocket_tts`, voix clonée depuis `plugins/tts/audiocpp/voices/ref_fr_siwis.wav`.
Autre voix possible : **Supertonic 3** (famille `supertonic`, voix intégrées F1…F5, M1…M5) : correcte, mais elle attend la
phrase entière (~1,3 s avant le premier son). Kokoro n'est pas retenu : en français, il a besoin d'eSpeak-ng (licence GPL),
que ni audio.cpp ni sherpa-onnx 2 ne fournissent.

### Écoute sans Python (sherpa-onnx)

Le plugin **Écoute** (`voice/listen`) remplace l'écoute du service Python : il assemble un **détecteur de parole** et une
**transcription**, choisis dans **Réglages → Écoute**. Les règles (interruption, phrase reprise, bouton, dictée) sont les mêmes.
Il ne parle pas : la voix vient d'un plugin de voix (cloud, audio.cpp ou voix du système).

Le lecteur **sherpa-onnx** (`stt/sherpa`) fait tourner les modèles ONNX dans Floppy, sur le processeur :

1. Télécharger `silero_vad.onnx` et `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (à décompresser) depuis
   [les modèles sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models).
2. Dans **Réglages → Écoute → sherpa-onnx**, ajouter le fichier `silero_vad.onnx`, puis le dossier Parakeet.
   Le type est reconnu aux fichiers : un `.onnx` seul est un détecteur, un dossier `encoder`/`decoder`/`joiner`/`tokens.txt` une transcription.

Les modèles ne se chargent qu'à l'ouverture de l'écoute (environ 1,5 s pour Parakeet). Mesure : une phrase de 6 s est transcrite
en environ 150 ms sur le processeur. Détails : [spec Écoute](../spec/ecoute.md).

### Voix du système

Le plugin **Voix du système** (`tts/system`) utilise les voix déjà installées sur l'ordinateur : gratuit, hors ligne, rien à télécharger.
L'ajouter dans **Réglages → Voix**, puis choisir une de ses voix (ex. « Microsoft Julie (fr-FR) ») comme voix en service.

| Système | Moteur | Voix |
|---|---|---|
| Windows | WinRT `Windows.Media.SpeechSynthesis`, par un `powershell.exe` gardé ouvert tant que la voix sert | voix OneCore (Paramètres → Heure et langue → Voix) ; les voix « naturelles » du Narrateur ne sont pas accessibles |
| macOS | `say` | voix de Réglages → Accessibilité → Contenu énoncé |
| Linux | `espeak-ng` (à installer) | une voix par langue |

Seules les voix de la langue de l'assistant et de l'anglais sont montrées ; le champ `languages` de la config change cette liste
(ex. `languages: [fr, de]`). Le système rend chaque phrase en entier (pas de flux) : un léger délai avant chaque phrase.

### Plugins de mot d'activation

Dans **Réglages → Écoute**, chaque plugin possède son formulaire. Configurer les instances puis choisir **Moteur de mot d'activation** (slot `listen.wakeword`) : une seule instance est active. Le nom de chaque instance dans le sélecteur est configurable. Les plugins peuvent aussi être ajoutés, désactivés ou retirés depuis cette rubrique.

- **Dans le texte transcrit** (`wakeword/stt`) : plugin sélectionné par défaut, qui cherche les mots dans chaque phrase déjà transcrite par l'écoute. Les mots et variantes se modifient directement dans son onglet (Réglages → Écoute → 3 · Mot d'activation), en pastilles ; chaque changement s'enregistre seul. Sous les mots, « Dernier réveil » montre la dernière phrase qui a réveillé Floppy. Les anciennes variantes du réglage `mot_activation` sont reprises. Aucun deuxième modèle ou flux STT n'est ouvert : la transcription ne tourne que quand le détecteur de parole entend quelqu'un parler.
- **Bouton uniquement** : aucun plugin wakeword actif ; le texte transcrit ne peut pas réactiver l'assistant hors de l'écoute libre.
- **Sherpa ONNX** : fichiers encoder/decoder/joiner ONNX, `tokens.txt` et mots tokenisés `keywords.txt`, seuil et threads CPU. Aucun compte requis. La langue et la reconnaissance de « Floppy » dépendent des modèles et mots fournis ; aucun modèle acoustique n'est téléchargé automatiquement. Voir la [documentation Sherpa](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_keyword_spotter.html).
- **Porcupine** : AccessKey dans le coffre système, modèle de mot `.ppn` compatible avec la plateforme et paramètres de langue `.pv`. Le champ « Nom du mot » étiquette le modèle ; il ne l'entraîne pas. L'activation du SDK utilise le compte Picovoice ; l'analyse audio s'effectue localement sur CPU. Voir la [documentation Porcupine](https://picovoice.ai/docs/api/porcupine-nodejs/).

Un détecteur dédié peut ouvrir Live dès la détection, sans attendre une transcription complète. Un court pré-roll configurable (1,5 s par défaut) et l'audio reçu pendant la connexion sont conservés pour le début de la demande. Le STT local reste utilisable pour la cascade et les commandes vocales. Un moteur sélectionné en erreur ne bascule pas silencieusement sur un autre ; le bouton parler reste disponible.

Pour ajouter un moteur, créer `plugins/wakeword/<nom>`, fournir `WakewordService` (type de `@floppy/contracts`), déclarer `provides: ["wakeword"]` et offrir chaque détecteur par `ctx.offer("wakeword", …)` comme les autres moteurs (c'est le slot `listen.wakeword` de la conversation qui le choisit), puis lui donner le champ `floppy` de son `package.json`. Le formulaire appartient au plugin (`ctx.items`/`providerConfig`) ; `onChange` prévient la conversation de recréer ses détecteurs. Un moteur audio reçoit du float32 mono 16 kHz avec des indices absolus. Un moteur `input: "transcript"` reçoit les transcriptions existantes par `pushTranscript`. Les détections reprennent l'horloge du corps ; sans indices, une transcription peut activer la cascade mais ne permet pas de rejouer de l'audio vers Live. Aucun changement de Gemini, GPT Live ou de la conversation n'est nécessaire pour un nouveau moteur.

Ces choix sont également accessibles par la CLI (après avoir renseigné les clés dans les formulaires) :

```powershell
npx floppy set service.tts tts-elevenlabs
npx floppy set service.tts tts-gemini
npx floppy set service.tts '@none'       # retour à la voix locale
npx floppy set service.live live-gemini
npx floppy set service.live live-openai
npx floppy set service.live '@none'     # retour à la cascade
```

Le fournisseur n'ouvre une connexion audio Live qu'après le mot d'activation local ou un énoncé en PTT.
Un tampon local borné à 30 secondes permet de transmettre l'énoncé activant, y compris si « Floppy » est dit à la fin.
Les phrases ignorées avant cet énoncé ne sont pas transmises. La session se ferme à l'expiration de l'écoute libre,
en veille, au débranchement du corps ou au changement de fournisseur. Une seule session Live est ouverte à la fois.

Gemini Live peut fonctionner sans `brain` ni `llm`. GPT Live délègue au `brain` choisi : local, distant ou CLI.
Le LLM local reste chargé tant que son entrée `llm` est activée dans le YAML ; la désactiver (`disabled: true`)
pour une configuration Gemini Live sans LLM local. `brain-aisdk` peut utiliser un modèle distant sans service `llm`.
Le STT local reste nécessaire pour l'activation ; un moteur de mot d'activation spécialisé est une évolution ultérieure.

Les outils Live passent par le même registre, les mêmes accords et le même audit que la cascade.
Une annulation ferme aussi les accords de la tâche annulée. Pour garantir la coupure de l'audio GPT Live sur WebSocket,
une interruption locale ferme sa session et annule ses tâches en attente ; l'énoncé suivant peut ouvrir une nouvelle session.
Pendant une demande d'accord, un signal sonore local et la carte de confirmation remplacent une injection dans la conversation
du fournisseur. « Oui/non » reste accepté pendant la lecture et ne coupe pas la tâche. Après un accord GPT, la voix reprend
sur une nouvelle connexion, avec le résultat confirmé, sans réexécuter l'action. Les délégations GPT sont traitées en série et
ne reçoivent que la nouvelle demande ; les échanges précédents sont du contexte.
Gemini utilise son événement d'interruption serveur et ses outils sont explicitement bloquants. Une fermeture `GoAway`
est signalée et nécessite une nouvelle activation.

La fin de lecture désarme l'interruption et remet l'état « écoute », même sans événement de fin de génération GPT.
Pour un corps sans retour `playback`, la durée PCM envoyée et une marge bornent la lecture estimée ; une session est aussi
limitée à 15 minutes. Les annonces importantes attendent un moment libre dans une session Live, avec journalisation.
Les erreurs de commande GPT corrélées à un événement client sont signalées sans fermer la session.

Modèles de départ, tous modifiables : `gemini-3.1-flash-tts-preview` (TTS via `streamGenerateContent` SSE),
`eleven_flash_v2_5` (HTTP PCM), `gemini-3.8-live` et `gpt-live-1` (délégation client, distinct de Realtime classique).
Les changements de modèle et de voix Live prennent effet à la prochaine session. Les tests réseau utilisent des réponses
simulées : l'accès réel au modèle, la qualité vocale, l'écho et les quotas doivent être vérifiés avec un compte fournisseur.
Le streaming Gemini TTS vérifie la fin `STOP` et refuse un flux incomplet ou un format différent du PCM attendu.

Sources des contrats : [GPT Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets),
[délégation GPT Live](https://developers.openai.com/api/docs/guides/live-delegation),
[Gemini Live WebSocket](https://aistudio.google.com/docs/live-api/get-started-websocket),
[Gemini TTS](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation),
[ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream).

## Écrire un plugin

Les ressources locales suivent les besoins déclarés (règles « à la demande » du noyau, voir `docs/spec/noyau.md`) : le modèle choisi (slot `brain.main`) et la voix choisie (slot `voice.tts`) tournent dans des forks, seulement quand un plugin actif s'en sert. En Gemini Live, rien ne s'en sert : llama-server et le modèle TTS local sont libérés sans code dédié. GPT Live demande le cerveau pour la délégation : il reste. Un llama-server lancé hors de Floppy est réutilisé et jamais arrêté.

Le hook `conversation.command` permet à un plugin de reconnaître une commande locale précise et de retourner `{ name, args }` (`ConversationCommandInput` et `ConversationCommand` dans le core). La conversation appelle ensuite l'outil visible via le registre habituel, avec annulation, règles et audit. Le plugin Electron y déclare l'ouverture des réglages et attend la confirmation de la fenêtre avant de réussir ; la conversation ne connaît aucun détail d'Electron.

```ts
import { definePlugin } from "@floppy/core";
import { z } from "zod";

export default definePlugin({
  manifest: { id: "mon-plugin", version: "0.1.0", licence: "MIT", provides: ["monService"], inject: ["llm"] },
  config: z.object({ port: z.number().default(9000) }),
  async apply(ctx, cfg) {
    const llm = ctx.get("llm");
    ctx.spawn("mon-exe", ["--port", String(cfg.port)]);   // tué au déchargement
    ctx.tools.register([/* outils : niveau read/write/send/delete, passent par l'accord */]);
    ctx.provide("monService", { /* … */ });
  },
});
```

Donner à son `package.json` le champ `"floppy": { "plugin": true }` (il est alors trouvé tout seul ; un `npm install` lie le nouveau workspace), puis l'ajouter à `floppy.yml`.
