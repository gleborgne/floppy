# Éléments : réglages pilotés par les plugins (implémenté)

La fenêtre des réglages ne contient **aucune liste en dur**. Chaque plugin déclare ce qu'il apporte. La fenêtre
en tire ses rubriques, ses listes et ses formulaires. Installer un plugin ajoute ses options tout seul.

Maquette de référence : [`maquette-reglages/`](maquette-reglages/) (9 écrans).

## Deux choses que les plugins déclarent

| Quoi | Exemple | Où dans le code |
|---|---|---|
| **Réglage** : une valeur simple | voix utilisée, ton, mot d'activation, langue | `SettingsRegistry` (`packages/core/src/settings.ts`), voir [reglages.md](reglages.md) |
| **Élément** : une chose qu'on ajoute, modifie, désactive, supprime | un modèle, une voix, un connecteur, un corps, un avatar | `CatalogRegistry` (`packages/core/src/catalog.ts`) |

Un réglage a une `section` (**obligatoire**) : la rubrique de la fenêtre où il apparaît. Un id de rubrique inconnu tombe dans « Plugins » (côté fenêtre). L'ancienne fonction `sectionOf` n'existe plus (testé : `packages/core/test/sections.test.ts`).

## Les rubriques déclarées par les plugins

Le menu de gauche n'est pas en dur. Chaque plugin déclare ses rubriques dans son manifeste (`manifest.sections`), et le noyau les range dans un `SectionRegistry` (`packages/core/src/sections.ts`). Le noyau déclare seulement **Général** et **Plugins** ; les autres viennent des plugins.

```mermaid
flowchart LR
  A["brain-aisdk<br/>cerveau · voix"] --> R
  B["conversation<br/>écoute"] --> R
  C["tools<br/>connecteurs"] --> R
  D["body-hub, body-electron<br/>corps · système"] --> R
  E["coder<br/>assistant"] --> R
  N["noyau<br/>général · plugins"] --> R
  R["SectionRegistry<br/>fusion par id"] --> W["Menu de la fenêtre"]
```

| Champ d'une rubrique | Rôle |
|---|---|
| `id`, `label`, `description`, `icon` | identité et texte (`Text` fr/en) |
| `order` | place dans le menu (petit = haut, défaut 100) |
| `parent` | la rubrique s'affiche comme un bloc dans la page du parent |
| `merge` | une seule liste pour toute la rubrique, quel que soit le plugin (corps, connecteurs) |
| `view` | vue spéciale de la fenêtre (« plugins », « assistant ») |

- Plusieurs plugins peuvent déclarer la **même** rubrique : elles fusionnent, champ par champ, et **le premier libellé gagne**. Si ce plugin part, le suivant prend le relais.
- Une rubrique sans réglage ni élément n'est pas montrée.
- Le fournisseur et le réglage pointent la rubrique par son id.

Réglages et fournisseurs ont quelques champs de plus pour la fenêtre :

| Champ | Où | Rôle |
|---|---|---|
| `role` | `SettingDef` | rôle fonctionnel libre. Les réglages `slot.<id>` ont le rôle `<id>` (ex. `brain.main`). |
| `offers` | `ProviderDef` | service que les éléments offrent (`ctx.offer`, même id d'élément). La fenêtre met « Activer » sur chaque élément, pour chaque slot de ce service. |
| `slow` | `SettingOption` | choisir cette valeur prend du temps (charger un modèle) : la voie rapide de la conversation le dit avant (« ça prend quelques secondes »). |
| `layout` | `ProviderDef` | `list` (liste + détail, défaut) ou `grid` (cartes : avatars). |
| `capabilities` | `ProviderDef` | capacités libres du fournisseur, par exemple `live` (modèle unique qui écoute et parle ; testé, mais aucun plugin livré ne le déclare encore). |

## Le modèle

```mermaid
flowchart LR
  subgraph P["Plugins"]
    L["llm-llamacpp"]
    O["llm-openai"]
    T["tools (MCP, commandes)"]
    V["tts-audiocpp"]
    R["body-reachy"]
    E["body-electron"]
  end
  subgraph K["Noyau"]
    C["CatalogRegistry<br/>fournisseurs par rubrique"]
    S["ItemStore<br/>&lt;home&gt;/items/*.json"]
    X["Secrets<br/>Gestionnaire d'identification Windows"]
  end
  W["Fenêtre des réglages<br/>(formulaires générés)"]
  F["Floppy à la voix<br/>lister_elements · activer_element · ajouter_application"]
  L & O & T & V & R & E -- "ctx.items.declare(fournisseur)" --> C
  L & O & T & V & R & E -. "ajouts, modifs, désactivés" .-> S
  O & T -. "clés, jetons" .-> X
  W -- "items.get / items.op" --> C
  F -- "enable seulement" --> C
```

- Un **fournisseur** (`ProviderDef`) appartient à une rubrique : `cerveau`, `voix`, `connecteurs`, `corps`, `avatars`.
- Il donne ses **types d'éléments** (`kinds`). Chaque type a des **champs** (`FieldDef`) : texte, nombre, oui/non,
  choix, secret, fichier, liste, texte long, paires clé = valeur, **enregistrement audio**. Options : champ requis,
  avancé (replié), visible selon un autre champ (`showIf`), filtres de fichier. Un fournisseur qui a 2 ou 3 types
  montre un bouton « + … » par type (ex. « + Nouvelle voix », « + Modèle de voix local ») ; au-delà, un seul bouton
  qui fait choisir le type.
- Champ **`audio`** (2026-11-07) : la fenêtre enregistre au micro (« M'enregistrer ») ou importe un fichier (WAV, MP3,
  M4A, OGG…). `prompts` : phrases à lire, une au hasard, « Autre phrase » en change ; `textKey` : le champ qui reçoit
  la phrase lue (sauf si l'utilisateur y a écrit autre chose) ; `seconds` : durée conseillée. À la fin, la fenêtre
  coupe le silence aux bords, vérifie la durée, la saturation et le bruit de fond, et donne le son en WAV mono 24 kHz,
  en adresse `data:audio/wav` (le plugin le lit avec `wavFromDataUrl` : 16 Mo au plus). Une valeur qui n'est pas une
  adresse `data:` est celle que le plugin a rendue (ex. le chemin du fichier gardé) : rien n'a changé. Le micro n'est
  ouvert que pendant l'enregistrement ; rien ne quitte l'ordinateur.
- Un **son à jouer** : `OpResult.audio` (adresse `data:audio/wav`, voir `wavDataUrl`). La fenêtre le joue après un
  essai (et montre un lecteur pour le réécouter) ou une action. Une action marquée `play` est un bouton rond
  « lecture » au début de la ligne de l'élément (ex. « Écouter » une voix).
- Il liste ses **éléments** (`ItemInfo`) : nom, détail, statut, en service ou pas, actif ou désactivé, nuage ou pas,
  sous-éléments (`children`, par ex. les outils d'un connecteur), boutons d'action.
- Il répond aux **opérations** : ajouter, modifier, supprimer, activer, choisir un sous-élément, essayer, action.
- Le bouton « Ajouter » d'une rubrique propose les types de **tous** les fournisseurs de la rubrique
  (par ex. Connecteurs : MCP local, MCP distant, commande — et demain un type apporté par un autre plugin).
- Un fournisseur `layout: "library"` liste ce qu'on peut **télécharger** (modèles, voix). Il n'est pas montré dans la
  page : la fenêtre met « Télécharger des modèles » sous les rôles de ses `offers`, et ouvre sa bibliothèque. Ses
  éléments portent `progress` (0 à 1, une barre) ; `search(query)` ajoute une case de recherche (opération
  `search`, résultat `items`). Voir [telechargements.md](telechargements.md) et l'aide `modelLibrary`.

## Désactiver n'est pas supprimer

| | Désactivé | Supprimé |
|---|---|---|
| Visible dans la fenêtre | oui, grisé | non |
| Vu par Floppy (cerveau, outils, alias à la voix) | non | non |
| Réglage gardé | oui | non |
| À la voix | « Floppy, désactive Qwen » | jamais |

On ne peut pas désactiver l'élément en service sans remplaçant (le modèle chargé, la voix utilisée).

## Qui peut faire quoi

| Opération | Fenêtre (clic) | CLI | Voix |
|---|---|---|---|
| Lister | oui | `GET /items` | `lister_elements` |
| Activer / désactiver | oui | `POST /items` | `activer_element` ; activer un élément **cloud** = demande d'accord |
| Ajouter une **application** livrée avec Floppy (Orca, navigateur…) | oui | `POST /items` | `ajouter_application` : **toujours** une demande d'accord, valeurs par défaut seulement |
| Ajouter un autre élément (MCP, commande…), modifier, supprimer | oui | `POST /items` | **jamais** (un MCP local lance une commande sur le PC) |

Le contrôle est fait dans `CatalogRegistry.run` : le modèle ne peut pas le contourner. Chaque opération va au journal.

### Installer une application à la voix

« Floppy, tu sais te connecter à Orca ? » → `lister_elements` montre, sous « À ajouter », les applications pas encore
ajoutées (plugins `manifest.addable`). « Oui, j'ai un plugin pour ça. » → « Alors installe-le. » → `ajouter_application`.

- Seuls les fournisseurs marqués `voiceAdd` l'acceptent (les « Applications » du noyau) : c'est du code livré avec Floppy.
  Un MCP ou une commande ne s'ajoutent jamais à la voix.
- Le noyau demande **toujours** l'accord (« Ajouter Orca », avec « données dans le cloud » si besoin), même si la règle
  `write` est « always ».
- Le formulaire prend ses **valeurs par défaut**. S'il a un champ obligatoire sans défaut (adresse, clé), Floppy répond
  d'ajouter l'application dans la fenêtre des réglages, sans rien demander.
- Une application « une seule à la fois » déjà ajoutée n'est pas ajoutée deux fois : éteinte, elle se rallume avec
  `activer_element`.

## Où sont gardées les choses

- `floppy.yml` n'est **jamais réécrit** par le code. Ses éléments sont la base.
- Ce que l'utilisateur change est dans `<home>/items/<fournisseur>.json` (`ItemStore`) : éléments ajoutés,
  modifications, ids désactivés, ids supprimés, sous-éléments choisis.
- Les secrets (clés d'API, jetons) vont dans le **Gestionnaire d'identification Windows** (`ctx.secrets`, paquet
  `@napi-rs/keyring`, MIT), sous le nom `floppy` / `<plugin>/<élément>/<champ>`. La fenêtre ne reçoit jamais un
  secret : elle voit seulement « enregistré ».

## Plusieurs langues

- La fenêtre des réglages et les menus de l'icône sont en **français et en anglais** (réglage `langue_interface`,
  rubrique Général).
- Les plugins donnent leurs textes en `Text` : `"Voix"` ou `{ fr: "Voix", en: "Voice" }` (`packages/core/src/i18n.ts`).
- Floppy reconnaît un nom dit à l'oral dans toutes les langues données.

## Les rubriques et leurs fournisseurs

| Rubrique | Fournisseurs (plugin) |
|---|---|
| Cerveau | `llm-local` (llm-llamacpp), `llm-remote` (llm-openai), `claude-cli` (brain-claude-cli), `codex-cli` (brain-codex-cli), `agy-cli` (brain-agy-cli) ; rôles « cerveau principal » et « délégation » (réglages de brain-aisdk) |
| Voix | `voix-locale` (tts-audiocpp) |
| Connecteurs | `connectors` (tools : MCP local, MCP distant, commande), `apps-connecteurs` (applications : navigateur, Orca) |
| Corps et affichage | `bodies` (body-hub), `ws-devices` (body-ws), `reachy` (body-reachy), `avatars` (body-electron) |

Le détail de chaque fournisseur est plus bas, rempli au fur et à mesure.

## Détail des fournisseurs

### Cerveau

| Fournisseur | Types (ajout) | Notes |
|---|---|---|
| `llm-local` (llm-llamacpp) | `gguf` : nom, mots à la voix, fichier GGUF, brouillon, emplacement (GPU / experts en RAM + `--n-cpu-moe`), contexte, réflexion, arguments avancés | Un seul modèle chargé. Le modèle chargé ne se désactive pas. « Essayer » estime la mémoire. Action `scan` : cherche des `.gguf` dans les dossiers de LM Studio et ceux du réglage « Dossiers de modèles ». |
| `llm-remote` (llm-openai, nouveau) | `openai` : nom, mots à la voix, adresse de base, modèle, clé d'API (secret), cloud | Toute API au format OpenAI (Mistral, OpenRouter, Azure OpenAI…). « Essayer » appelle `/models`. Choisir un modèle distant à la voix = accord. |
| `claude-cli` (brain-claude-cli) | aucun | **Un seul élément** « Claude Code (CLI) ». Sa page a deux choix : le modèle du cerveau principal (défaut `model`, Sonnet) et le modèle de délégation (défaut `delegateModel`, Opus). Appliqué à la demande suivante, sans redémarrage. Les anciens choix par modèle (`claude/opus`…) reviennent sur `claude` (`OfferDef.renamed`). Le tri (service `completion`) garde un élément par modèle. |
| `codex-cli` (brain-codex-cli, nouveau) | aucun | Un seul élément « Codex », mêmes deux choix (liste `models`). `codex app-server`, un fil par session, seulement le MCP Floppy (voir [Le cerveau](cerveau.md)). |
| `agy-cli` (brain-agy-cli, nouveau) | aucun | Un seul élément « Antigravity », mêmes deux choix (défaut : Flash en principal, Argon en délégation). Maison isolée. Conditions de Google peu claires : proposé seulement si on l'ajoute. |

Slots de la rubrique Cerveau : `brain.main` (déclaré par brain-aisdk : modèles locaux, distants, ou un CLI comme agent : Claude, Codex, Antigravity) et
`brain.delegate` (déclaré par brain-aisdk, facultatif : « Pas de délégation »). Chaque élément a un bouton « Activer »
(« Activer comme cerveau principal » / « … délégation » quand il peut remplir les deux). Le modèle choisi tourne dans un fork
de son plugin, seulement quand le cerveau tourne. Changer de modèle local ferme l'ancien llama-server puis lance le nouveau.

```mermaid
flowchart LR
  A["« Activer » sur un élément<br/>(slot brain.main)"] --> B{"élément"}
  B -- "llm/gemma" --> L["fork llama-server<br/>(10-60 s, tué quand plus utilisé)"]
  B -- "llmremote/mistral" --> R["fork API compatible OpenAI<br/>clé lue dans le trousseau à chaque tour"]
  B -- "claude/claude" --> C["fork agent Claude Code<br/>(modèle du cerveau principal)"]
  B -- "codex/codex" --> X["fork codex app-server"]
  B -- "antigravity/antigravity" --> G["fork agy (maison isolée)"]
```

Mode **Live** : interrupteur « Séparé / <moteur Live> » en haut de la rubrique (slot `conversation.live`, `display: "mode"`).
Les moteurs Live (Gemini Live, GPT Live) ont aussi « Activer ». En Live, le modèle Live est à la fois cerveau et voix ; la
délégation reste ; le mot d'activation reste local. Les moteurs qui ne servent pas dans le mode en cours sont grisés (« en veille »).
La ligne « En service » en haut de la page montre chaque slot, son élément et son état (chargement, en veille, en panne).

### Voix

| Fournisseur | Types (ajout) | Notes |
|---|---|---|
| `voix-locale` (tts-audiocpp, `offers: "tts"`) | `voice` (« Nouvelle voix ») : nom, enregistrement (champ `audio`), ce qu'il dit, modèle qui la fait parler (seulement ceux qui clonent : Qwen3-TTS, VoxCPM2, Pocket TTS), phrase d'essai. `gguf` : nom, fichier, famille (Qwen3-TTS, VoxCPM2, Pocket TTS, Supertonic, autre), voix clonée (WAV + texte) ou intégrée (nom), style, langue | Voir « Studio de voix » ci-dessous. Le service Python `voices` (voice-cascade) est archivé depuis le 6 novembre 2026. |
| `sherpa` (stt-sherpa, `offers: ["vad", "stt"]`) | `onnx` : nom, fichier ou dossier ; le type (détecteur ou transcription) est lu aux fichiers | Voir [ecoute.md](ecoute.md). |
| `tts-elevenlabs-account`, `tts-gemini-account` (`offers: "tts"`) | compte : modèle, voix, clé | « Activer » sur le compte = cette voix cloud en service (accord à la voix). |

Slot `voice.tts` (déclaré par la conversation) : « Activer » sur une voix choisit le moteur **et** la voix. Le réglage `ton` est aussi dans la rubrique Voix.

#### Studio de voix (2026-11-07)

Une **voix** n'est plus un modèle : c'est un enregistrement de 10 à 20 s et la phrase qu'il contient (quelques centaines
de Ko). Le **modèle** (le fichier GGUF, 2,5 Go pour Qwen3-TTS 1.7B) est partagé par ses voix. Maquette :
<https://claude.ai/artifact/S8bjdyUCVGTL19pbDn31YB>.

- Chaque élément de `voix-locale` reste un couple « voix + modèle » (l'élément offert au slot), mais il est toujours
  rangé sous son modèle (`group` = le fichier GGUF). La page montre d'abord **les voix** (taille absente), puis **les
  modèles** (taille, format, carte graphique ou processeur, chargé ou en veille). Les 26 voix intégrées d'un modèle
  sont repliées : on voit celle en service, et « 25 autres dans Pocket TTS · Voir ».
- **Nouvelle voix** : la fenêtre fait lire une phrase au micro (ou importe un fichier), vérifie l'enregistrement, puis
  le plugin le **copie** dans `<dossier de Floppy>/tts-audiocpp/voices/<uuid>.wav` : l'original peut disparaître. Un
  nouvel enregistrement remplace l'ancien fichier ; supprimer la voix efface son fichier. Un fichier de l'utilisateur
  (ancienne voix clonée qui pointe ailleurs) n'est jamais effacé.
- Une voix clonée se modifie avec le formulaire `voice` (type de l'élément : `voice` si clonée, `gguf` si intégrée).
  Son action **Écouter** (`play`) rend l'enregistrement.
- **Essayer** : la phrase d'essai est dite par le modèle **chargé en ce moment** (le serveur n'en garde qu'un),
  l'enregistrement partant en `voice_ref` avec `reference_text` (Qwen3-TTS, VoxCPM2) : pas de redémarrage du serveur.
  Rien de chargé, ou un modèle qui ne clone pas (Supertonic) : un message dit comment l'entendre (garder la voix, la
  choisir).
- Pas encore : **décrire** une voix (modèle Qwen3-TTS VoiceDesign) ; transcrire seul un fichier importé (on écrit la
  phrase à la main).

### Connecteurs

| Fournisseur | Types (ajout) | Notes |
|---|---|---|
| `connectors` (tools) | `mcp-local` (commande, arguments, variables, une variable secrète, cloud, filtre) ; `mcp-remote` (adresse, connexion : aucune / jeton secret / Azure CLI) ; `command` (une commande sans shell devient un outil : `{texte}` dans les arguments, niveau lecture ou écriture, délai, sortie coupée à 4000 caractères) | Tout se fait à chaud. Sous-éléments = outils du serveur avec leur niveau ; cocher = donné au cerveau. « Essayer » se connecte et liste les outils sans rien enregistrer. Les anciens réglages `connecteur_<clé>` sont repris une fois puis supprimés. |
| `apps-connecteurs` (noyau) | un type par plugin « application » : `browser` (navigateur), `orca` | Voir « Applications » plus bas. |

Exemple : ajouter le MCP Office 365 = « Ajouter » → « Serveur MCP local » → commande donnée par la doc du serveur
→ « Essayer » → cocher les outils de lecture → « Ajouter ». Aucun code à changer.

### Corps et affichage

| Fournisseur | Types (ajout) | Notes |
|---|---|---|
| `bodies` (body-hub) | aucun | Corps branchés et leurs capacités. Désactivé = le hub l'ignore (pas de tours, pas de réponses, pas d'accords). |
| `ws-devices` (body-ws) | `device` « Autre appareil » | Crée un jeton nommé, montré une seule fois avec l'adresse `ws://`. Seule l'empreinte sha256 est gardée. **Désactiver** = l'appareil est débranché et ne peut plus se brancher, mais le jeton est gardé. Supprimer = jeton révoqué. Un appareil à jeton est listé **ici seulement** (pas une 2e fois sous `bodies`). |
| `reachy` (body-reachy, nouveau) | `reachy` : nom, adresse du daemon, micro, accord | Voir [corps-et-avatar.md](corps-et-avatar.md#reachy-mini). Actions `detect`, `nod`, `joy`. |
| `avatars` (body-electron) | aucun | Cartes (`layout: "grid"`). Avatars des plugins `plugins/avatar/<id>/avatar.json`, inscrits auprès du service `avatars`. Action `use`. L'avatar affiché ne se désactive pas. |

## Applications : des plugins qu'on ajoute ou retire

Certains plugins sont des **applications** : l'utilisateur les ajoute, les éteint ou les retire lui-même, comme un
connecteur. Exemples : **Navigateur** (outil `ouvrir_url`) et **Orca**. Un plugin le devient en déclarant
`manifest.addable` (`packages/core/src/plugin/manifest.ts`) :

```ts
addable: {
  section: "connecteurs", single: true,
  label: { fr: "Navigateur", en: "Web browser" },
  description: { fr: "…", en: "…" },
  fields: [ { key: "ask", label: { fr: "Demander mon accord avant d'ouvrir", en: "Ask me before opening" }, type: "boolean", default: true } ],
}
```

```mermaid
flowchart LR
  Y["floppy.yml<br/>(entrées de base)"] --> T["Transformation du noyau<br/>(packages/core/src/apps.ts)"]
  S["&lt;home&gt;/items/apps.json<br/>ajoutées · retirées · éteintes · outils cachés"] --> T
  T --> K["Entrées du noyau<br/>(démarrées / arrêtées à chaud)"]
  W["Réglages → Connecteurs<br/>fournisseur « Applications »"] -- "ajouter / éteindre / retirer" --> S
```

- Le noyau montre, pour chaque rubrique qui a des applications, un fournisseur « Applications » (`apps-<rubrique>`).
  Ses types d'ajout = les plugins installables ; le formulaire = `fields` (la config de l'entrée).
- Éteindre = l'entrée s'arrête (outils retirés). Retirer = l'entrée n'existe plus (même si elle est dans
  floppy.yml). Rajouter = une nouvelle entrée avec la config du formulaire.
- Sous-éléments = les outils de l'entrée. Décocher = l'outil est caché au cerveau (`ToolRegistry.setHidden`) ;
  un appel à un outil caché échoue.
- Un plugin montre un état court sur son élément avec `ctx.items.status(texte, ton)` (Orca : « surveillance
  active », « Orca ne répond pas »).

### Navigateur (`plugins/tools/browser`)

- Outil `ouvrir_url`. Seulement `http` et `https`. Lancé sans shell (`rundll32 url.dll,FileProtocolHandler` sous
  Windows, ou le programme choisi).
- Accord avant chaque ouverture par défaut (case « Demander mon accord avant d'ouvrir »).
- Avant, c'était un outil de l'avatar : un corps sans écran (Reachy, Telegram) ne pouvait pas ouvrir de page, et on
  ne pouvait pas l'enlever. Maintenant, c'est une application indépendante du corps.
- Sa description dit au cerveau de ne jamais répondre « je ne peux pas ouvrir une page ». Les connecteurs ont un
  champ « Note pour le cerveau » : pour Azure DevOps, elle donne le modèle d'adresse web d'une PR, d'un ticket ou
  d'un build.

### Réglages d'un élément : bouton « Configurer »

Un réglage déclaré par une application (ex. `orca_notifications`, `orca_surveillance`) appartient à son élément
(`ItemInfo.settings`). La fenêtre le montre **dans l'élément**, sous le bouton « Configurer », et plus dans la liste de
la rubrique. Une application peut aussi avoir ses propres boutons (`ctx.items.actions`, ex. « Se connecter »).

### Microsoft 365 (`plugins/tools/m365`)

Mails, agenda, personnes, fichiers (OneDrive, SharePoint) et conversations Teams, par Microsoft Graph. **Lecture**, plus **écriture dans l'agenda** seulement (voir plus bas).

```mermaid
sequenceDiagram
  actor U as Utilisateur
  participant W as Réglages (clic « Se connecter »)
  participant P as plugin m365
  participant M as login.microsoft.com
  participant K as Trousseau Windows
  U->>W: Se connecter
  W->>P: action login
  P->>M: code d'appareil (Mail.Read, Calendars.ReadWrite, People.Read, Files.Read.All, Chat.Read)
  P-->>W: « tape le code ABC123 sur login.microsoft.com/device »
  U->>M: code + compte de travail
  P->>M: attend la fin (toutes les 5 s)
  M-->>P: jeton d'accès + jeton de rafraîchissement
  P->>K: jeton de rafraîchissement (jamais dans un fichier)
  Note over P: ensuite : renouvellement seul, plus de fenêtre de connexion
```

- Pourquoi pas Work IQ (`@microsoft/workiq`) : sa connexion passe par WAM (le gestionnaire de comptes de Windows),
  qui échoue sur ce PC (`IncorrectConfiguration`), d'où une fenêtre de connexion à chaque question et des réponses
  vides. Le code d'appareil n'utilise pas WAM ; testé : connexion acceptée par le tenant, Graph répond (200).
- Application publique de Microsoft « Microsoft Graph Command Line Tools » (celle de Graph PowerShell) : aucune
  inscription d'application à faire. Permissions déléguées : lecture (mails, personnes, fichiers, Teams), lecture et écriture pour l'agenda (`Calendars.ReadWrite`).
- Outils de lecture (`m365_*`, niveau lecture) : `mails_non_lus`, `chercher_mails`, `lire_mail`, `agenda`, `prochain_rdv`,
  `chercher_personnes`, `chercher_fichiers`, `conversations_teams`. Le contenu des mails est marqué comme une donnée,
  jamais une consigne.
- Se connecter / se déconnecter : boutons de l'élément, clic seulement (refusé à la voix).
- **Écriture dans l'agenda** (permission `Calendars.ReadWrite`, niveau `write` = carte d'accord à chaque fois) :
  `m365_ajouter_rdv` (titre, début, durée, lieu, rappel ; personne n'est invité, donc aucun mail n'est envoyé) et
  `m365_ajouter_rappel` (créneau de 15 min marqué « libre », catégorie « Floppy », notification à l'heure dite).
  Heures données en heure locale (`AAAA-MM-JJTHH:MM`), envoyées à Graph en UTC. Le cerveau reçoit la date ISO et
  l'heure actuelle dans son prompt.


## Pages à slots : la même grammaire partout (2026-11-06)

Maquettes : https://claude.ai/artifact/5nKLYZefR6rUGoEf38Z1US. La fenêtre ne connaît aucun slot : tout vient de `settings.slots`,
des fournisseurs (`offers`, `source`) et des applications (`apps-<rubrique>`).

| Mot | Sens |
|---|---|
| **Activer** | met un élément en service (modèle, voix, moteur Live, mot d'activation) ; un seul par slot |
| **en service** (badge vert) | l'élément qui sert ; le même badge sur l'onglet du mode ou du plugin en service |
| **Réglages** (flèche « › ») | ouvre la page de l'élément : son formulaire **en place**, Masquer / Rendre disponible, Supprimer. Chaque changement s'enregistre seul (champ quitté, Entrée, case cochée, pastille ajoutée ou retirée) ; « ✓ Enregistré » ou l'erreur s'affichent sur le formulaire. Un champ obligatoire vide n'est pas envoyé. La fenêtre (éditeur) ne sert plus qu'à **ajouter** (2026-11-07) |
| **Actif** (interrupteur) | seulement sur un plugin (application) : éteint = l'entrée s'arrête, rien n'est supprimé. Dans l'onglet d'un plugin, Retirer / Actif n'apparaissent que si la page n'a pas d'onglet Plugins, ou pour rallumer un plugin éteint |
| **+ Ajouter un plugin** | ouvre le catalogue. Depuis un rôle (ex. mot d'activation) ou l'onglet Plugins d'une page : seulement les plugins dont le manifeste fournit (`provides`) un service de ce rôle, aussi pour « Créer le tien » ; la pastille « Pour : … » enlève le filtre. Ailleurs : filtré sur la rubrique ; « + Ajouter un modèle / une voix » ouvre le formulaire du plugin |

Affichage d'un slot (`SlotDef.display`) :

- `"mode"` : onglets de mode en haut de la rubrique. « aucun » = le mode par défaut (`none`, ex. **Local**), l'autre = le libellé du slot (ex. **Live**). L'onglet Local montre les autres slots de la rubrique ; l'onglet Live montre les moteurs. Activer dans l'onglet d'un mode qui n'est pas en service passe Floppy dans ce mode.
- `"tabs"` : un onglet par plugin qui offre le service (Voix, mot d'activation), plus « aucun » si le slot le permet. Un plugin qui n'offre qu'un élément (ex. « Dans le texte transcrit ») : pas de ligne qui répète l'onglet ; son formulaire est directement dans l'onglet, puis sa ligne de détail. S'il n'est pas en service, sa ligne reste au-dessus, pour l'activer. Un plugin « Installé » dans le catalogue a toujours son onglet : qu'il déclare ses éléments (`ctx.items.declare` avec `offers`), qu'il n'offre ses choix que par `ctx.offer` (ex. Voix du système : ses choix viennent des options du slot), ou qu'il soit éteint (l'onglet dit alors « éteint » et garde l'interrupteur Actif). Si les éléments ont un `group` (ex. le modèle d'une voix) : d'abord tous les éléments (ce qu'on choisit), puis les groupes avec leur description et leur état ; un groupe de plus de 6 éléments est replié (« N autres dans … · Voir »).
- sans : une liste groupée par plugin (cerveau principal, délégation), puis les cartes des plugins.

Chaîne d'étapes (`SlotDef.step`, 2026-11-07) : quand **tous** les slots d'une rubrique (hors mode) ont un `step` et qu'il
y en a au moins deux, leurs onglets deviennent des cases numérotées, dans l'ordre, reliées par des flèches. Chaque case
dit le rôle et ce qui est en service. Ex. Écoute : 1 · Détecteur de parole (`listen.vad`) → 2 · Transcription
(`listen.stt`) → 3 · Mot d'activation (`listen.wakeword`). Les autres onglets (Plugins) suivent.

Champ `list` : des pastilles. × retire, Entrée ou virgule ajoute, un collage de plusieurs lignes donne plusieurs
pastilles, pas de doublon (sans tenir compte des majuscules).

Tous les plugins intégrés sont des applications (`manifest.addable`) : llama.cpp, API compatible OpenAI, Claude Code, Voix locale, Gemini Live, GPT Live, ElevenLabs, Gemini TTS, les détecteurs de mot d'activation. Le catalogue liste les types `addable` par rubrique (« Intégrés » ; « Marketplace » plus tard), avec « Installé » ou « Ajouter », et « Créer le tien » (types d'éléments des plugins installés : MCP local, modèle GGUF…).

Le mot d'activation est un slot (`listen.wakeword`, déclaré par la conversation) : le détecteur choisi tourne dans un fork, seulement tant que la conversation tourne.
