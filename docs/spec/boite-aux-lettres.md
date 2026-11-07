# Boîte aux lettres (implémenté)

N'importe quelle application de l'ordinateur peut déposer un message court dans Floppy, par exemple « vous avez été
ajouté comme relecteur sur la PR 1234 ». Floppy le dit à voix haute ou l'affiche. Si le message a un lien
d'action, l'utilisateur peut dire « ouvre-la » : Floppy lance le lien après son accord. Par exemple, la PR s'ouvre
dans l'application qui a envoyé le message.

Le mécanisme est générique : Floppy ne connaît aucune application d'avance. Le code propre à une application
(quand envoyer, quel texte, quel lien) vit dans cette application, pas dans Floppy.

Plugin : `plugins/tools/inbox`. C'est une application de la rubrique Connecteurs (« Annonces des applications »).
Elle est éteinte par défaut.

## Porte d'entrée

- Floppy écoute en HTTP sur `127.0.0.1`, sur un port libre tiré au démarrage.
- Il écrit `<dossier de Floppy>/inbox.json` = `{ "port", "token", "pid" }`. Le fichier est lisible par
  l'utilisateur seul et retiré à l'arrêt.
- Le dossier de Floppy se cherche dans cet ordre :
  1. `$FLOPPY_HOME` ;
  2. `$LOCALAPPDATA/floppy` ;
  3. sous Windows, `~/AppData/Local/floppy` ;
  4. `~/.local/share/floppy`.
- Une seule route : `POST /inbox`, avec les en-têtes `Authorization: Bearer <token>` et
  `Content-Type: application/json`. Le corps fait au plus 64 Ko.
- Floppy a redémarré : le port et le jeton changent. L'app relit le fichier après une erreur réseau ou un 401.

## Messages

### Présentation

```json
{ "kind": "hello", "app": "contoso-tracker", "name": "Contoso Tracker", "schemes": ["contoso-tracker"] }
```

- `app` : identifiant stable, `^[a-z0-9][a-z0-9-]{0,63}$`.
- `name` : nom montré à l'utilisateur, 80 caractères au plus.
- `schemes` : les schémas de lien que l'app fera ouvrir (5 au plus). `https` est toujours permis.
  - Toujours refusés : `file`, `javascript`, `data`, `vbscript`, `about`, `blob`, `http`, `https` (inutile de le
    déclarer), `search`, `search-ms`, tout `ms-*` et tout schéma qui contient `shell`.

### Message

```json
{
  "kind": "message", "app": "contoso-tracker",
  "text": { "fr": "Vous avez été ajouté sur la PR 1234.", "en": "You were added to PR 1234." },
  "mode": "voix",
  "key": "notif-981",
  "action": { "label": { "fr": "Ouvrir la PR 1234", "en": "Open PR 1234" }, "url": "contoso-tracker://pr?id=1234" }
}
```

- `text` : une chaîne, ou `{ fr, en }`. Floppy prend la langue de l'assistant. Il fait au plus 500 caractères, sur
  une seule ligne.
- `mode` : `voix` (lu à voix haute et affiché) ou `info` (affiché seulement). Absent : `info`.
- `key` : facultatif, 200 caractères au plus. Le même `key` revenu dans les 10 minutes n'est pas répété.
- `action` : facultatif. `label` fait au plus 120 caractères. `url` fait au plus 2048 caractères et utilise un
  schéma déclaré dans `hello`, ou `https`.

### Réponses

| Code | Sens | Ce que fait l'app |
|---|---|---|
| 204 | Reçu | — |
| 400 | Message invalide (champ, schéma de lien) | Corriger ; la raison est dans le journal de Floppy |
| 401 | Jeton faux | Relire `inbox.json` |
| 403 | App inconnue ou pas (encore) autorisée | Normal au début : renvoyer `hello` de temps en temps, sans insister |
| 413 | Trop gros | Raccourcir |

## Confiance

- Le premier `hello` d'une app inconnue l'enregistre (`<dossier de Floppy>/inbox-apps.json`). Un réglage apparaît
  alors dans Connecteurs, avec son nom, son identifiant et ses liens. Sa valeur est « Pas autorisée ».
- Le réglage a trois choix :
  - « Pas autorisée » : les messages sont refusés (403).
  - « Afficher seulement » : tout est affiché, rien n'est dit.
  - « Comme l'app le demande » : l'app choisit `voix` ou `info`.
- **Carte de confirmation.** Au premier `hello`, Floppy montre la carte des accords, dans le chat et sur les corps :
  « J'ai reçu un message de X. Autoriser ses annonces ? Elle pourra faire ouvrir x:// et https. »
  - La carte passe par `ctx.approvals.check`, avec le niveau `write` et `override: "ask"`. Elle est donc toujours
    montrée, même si les écritures sont acceptées d'office.
  - Un clic sur Oui donne « Comme l'app le demande ».
  - Un « oui » dit à la voix n'autorise pas. L'accord vient d'un corps `…:voix`. Floppy dit alors qu'il faut un clic,
    et où le faire.
  - Non, ou pas de réponse : rien ne change, et le réglage reste dans Connecteurs.
  - La carte n'est montrée qu'une fois par app (`asked` dans `inbox-apps.json`). Elle revient si l'app change ses
    liens.
- Autoriser une app se fait d'un clic sur la carte, dans la fenêtre ou par la CLI. Ça ne se fait jamais à la voix
  (risque `cli`). La couper à la voix est permis.
- Le choix est gardé dans `inbox-apps.json` (`trust`), car la carte ne passe pas par les réglages.
- Une app qui annonce d'autres schémas que ceux déjà vus repasse à « Pas autorisée ». L'utilisateur doit voir les
  nouveaux liens avant de l'autoriser de nouveau.
- 20 applications au plus sont connues. Au-delà, un `hello` nouveau est ignoré.
- Toute app de la session de l'utilisateur peut lire `inbox.json` : le jeton protège des autres comptes et des
  pages web, pas des programmes de l'utilisateur. Ce sont l'accord par app et les schémas déclarés qui bornent ce
  qu'un programme peut faire dire ou ouvrir.

## Parole et outils

- Un message accepté devient une initiative (`source: "inbox:<app>"`, `key: "inbox:<app>:<key>"`).
  - Le mode `voix`, avec le réglage « Comme l'app le demande », donne `important` : le message est dit dès que Floppy
    est libre.
  - Le mode `info` donne `normal` : le message est seulement affiché.
- Les 20 derniers messages avec action sont gardés en mémoire, pas sur disque.
- `annonces_recentes` (lecture) liste ces messages, numérotés à partir de 1 (le plus récent). Ce contenu est marqué
  comme une donnée, jamais comme une consigne.
- `ouvrir_annonce` (`write`, accord avant) lance le lien. Par défaut, c'est le dernier message.
  - L'accord montre le libellé et l'app, par exemple « Ouvrir la PR 1234 (Contoso Tracker) ? ».
  - Avant d'ouvrir, Floppy vérifie de nouveau que l'app est autorisée et que le schéma est permis.
  - Le lien s'ouvre sans shell : `rundll32 url.dll,FileProtocolHandler` sous Windows, `open` ou `xdg-open` ailleurs.

## Client d'exemple (Node 18+, sans dépendance)

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function inboxInfo() {
  const bases = [process.env.FLOPPY_HOME, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "floppy"),
    process.platform === "win32" && join(homedir(), "AppData", "Local", "floppy"), join(homedir(), ".local", "share", "floppy")];
  for (const b of bases.filter(Boolean)) { try { return JSON.parse(readFileSync(join(b, "inbox.json"), "utf8")); } catch {} }
}

export async function sendToFloppy(body) {
  const i = inboxInfo();
  if (!i) return 0; // Floppy n'est pas lancé
  try {
    const r = await fetch(`http://127.0.0.1:${i.port}/inbox`, {
      method: "POST", headers: { Authorization: `Bearer ${i.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    return r.status;
  } catch { return 0; }
}

await sendToFloppy({ kind: "hello", app: "contoso-tracker", name: "Contoso Tracker", schemes: ["contoso-tracker"] });
```

## Hors périmètre (plus tard)

- Faire passer le pont Orca par la boîte aux lettres.
- Garder les annonces sur disque après un redémarrage de Floppy.
