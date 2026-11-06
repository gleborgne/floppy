# Recevoir les résultats de Floppy sur Telegram ou par mail

[← Tous les guides](README.md)

Floppy peut t'envoyer ses résultats, par exemple **ta veille du matin**, dans un canal Telegram ou dans ta boîte mail. Tu règles un canal une fois. Ensuite, tu choisis ce que Floppy y envoie.

Ce guide prend 10 minutes. Il a trois parties :

1. [Telegram](#1-telegram)
2. [Gmail](#2-gmail-ou-une-autre-boîte-mail)
3. [Choisir quoi envoyer](#3-choisir-quoi-envoyer)

---

## 1. Telegram

Floppy écrit dans Telegram avec **un bot** : un compte Telegram que Floppy pilote. Le bot publie dans **ton canal**.

### Étape 1 : créer le bot

1. Dans Telegram, cherche **@BotFather** (le compte officiel de Telegram, avec une coche bleue).
2. Écris-lui `/newbot`.
3. Donne un nom au bot (exemple : « Floppy de Guillaume »), puis un identifiant qui finit par `bot` (exemple : `floppy_guillaume_bot`).
4. @BotFather répond avec un **jeton** qui ressemble à `1234567890:AAH…`. **Garde ce message pour toi.**

> Le jeton est la clé du bot. Quelqu'un qui a le jeton peut publier à la place du bot. Ne le colle que dans Floppy.

### Étape 2 : créer le canal et y ajouter le bot

1. Dans Telegram : **Nouveau canal**. Donne-lui un nom (exemple : « Ma veille »).
2. Choisis **Canal privé**. Ta veille dit ce qui t'intéresse : inutile que tout le monde la lise.
3. Ouvre le canal → **Administrateurs** → **Ajouter un administrateur** → cherche ton bot.
4. Dans ses droits, coche **seulement « Publier des messages »**. Décoche tout le reste (modifier le canal, supprimer des messages, ajouter des administrateurs…).

Pourquoi si peu de droits ? Si le jeton est volé un jour, le voleur pourra publier, mais il ne pourra pas prendre ton canal.

### Étape 3 : régler Floppy

1. Ouvre **Réglages → Notifications → « + Ajouter un canal Telegram »**.
2. **Nom** : comme tu veux (exemple : « Ma veille »). C'est ce nom que tu diras à Floppy.
3. **Jeton du bot** : colle le jeton de l'étape 1.
4. **Canal** :
   - canal public : `@nomducanal` ;
   - canal privé : son numéro, qui commence par `-100`. Pour le trouver : publie un message dans le canal, enregistre le canal dans Floppy avec un numéro au hasard, puis clique **« Trouver l'id »** dans sa fiche. Floppy affiche le numéro. Corrige le canal avec **Modifier**.
5. Clique **« Essayer »**. Le message « Test de Floppy : ce canal est prêt. » doit arriver dans le canal. Puis **Ajouter**.

### Étape 4 : verrouiller (2 minutes, conseillé)

| À faire | Pourquoi |
|---|---|
| Chez @BotFather : `/setjoingroups` → ton bot → **Disable** | Personne ne pourra ajouter ton bot dans un autre groupe. |
| Paramètres du canal → **Discussion** : pas de groupe relié | Sinon, des gens peuvent commenter sous les messages. |
| Ne partage pas le lien d'invitation du canal | Un canal privé reste privé tant que le lien ne circule pas. |

**Qui peut écrire dans ton canal ?** Seulement ses administrateurs : toi et le bot. Les abonnés lisent, sans pouvoir écrire. Et aujourd'hui le bot ne fait qu'envoyer : écrire au bot ne fait rien faire à Floppy.

> **Plus tard : discuter avec Floppy sur Telegram.** Ce même bot pourra servir à parler à Floppy. Il lira alors les messages qu'on lui écrit. Floppy ne répondra qu'**à toi** : seuls les comptes Telegram que tu autorises (par leur numéro d'utilisateur) pourront lui parler, et seulement en discussion privée. Les réglages de ce guide restent bons : bot sans droits en trop, `/setjoingroups` sur Disable, jeton gardé secret. Le jeton deviendra encore plus précieux : avec lui, on pourrait lire ce que Floppy t'écrit.

**Le jeton a fuité ?** Chez @BotFather : `/revoke` → ton bot. L'ancien jeton ne marche plus. Colle le nouveau dans Floppy : fiche du canal → **Modifier**.

---

## 2. Gmail (ou une autre boîte mail)

Floppy t'envoie un mail avec **tout le contenu** dedans : titres, liens, tableaux.

Gmail refuse ton mot de passe habituel pour ce genre d'envoi. Il faut un **mot de passe d'application** : un mot de passe à part, qui sert seulement à envoyer des mails, et que tu peux supprimer quand tu veux.

### Étape 1 : créer le mot de passe d'application

1. La **validation en deux étapes** doit être active sur ton compte Google (Compte Google → Sécurité). Sinon, active-la d'abord.
2. Va sur **https://myaccount.google.com/apppasswords**.
3. Nom de l'application : `Floppy`. Clique **Créer**.
4. Google affiche **16 lettres**. Copie-les : Google ne les montrera plus.

### Étape 2 : régler Floppy

1. **Réglages → Notifications → « + Ajouter une boîte mail »**.
2. **Nom** : exemple « Gmail perso ».
3. **Fournisseur** : Gmail.
4. **Ton adresse mail**, et le **mot de passe d'application** (les 16 lettres).
5. **Envoyer à** : laisse vide pour t'écrire à toi-même.
6. Clique **« Essayer »** : Floppy vérifie la connexion, sans envoyer de mail. Puis **Ajouter**.
7. Pour un vrai mail de test : fiche de la boîte → **« Envoyer un mail de test »**.

Outlook : choisis le fournisseur **Outlook**. Autre boîte : choisis **Autre**, puis indique le serveur, le port et la sécurité dans **Avancé** (ton hébergeur mail les donne).

**Arrêter :** supprime la boîte dans Floppy, et supprime le mot de passe d'application sur https://myaccount.google.com/apppasswords.

---

## 3. Choisir quoi envoyer

### Chaque jour, automatiquement

**Réglages → Tâches → « Veille du jour » → « Envoyer … à »** : choisis un ou plusieurs canaux (exemple : « Ma veille, Gmail perso »). « nulle part » arrête les envois.

Ou dis-le : « Floppy, envoie ma veille sur Telegram ». Floppy demande ton accord, car c'est un envoi hors de ton ordinateur.

### Une seule fois

« Floppy, envoie la synthèse par mail. » Floppy envoie le dernier document (la veille, une réponse affichée…), après ton accord.

### Si ça ne marche pas

Floppy te prévient avec la raison. Les plus courantes :

| Message | Que faire |
|---|---|
| jeton refusé | Le jeton est faux ou a été révoqué : recolle-le (fiche → Modifier). |
| canal introuvable | Le bot n'est pas administrateur du canal, ou le canal est mal écrit. |
| le bot n'a pas le droit d'écrire ici | Donne-lui le droit « Publier des messages ». |
| adresse ou mot de passe d'application refusé | Recrée un mot de passe d'application (étape 2.1). |
| serveur mail injoignable | Pas d'internet, ou serveur/port faux (fournisseur « Autre »). |

---

## Ce que Floppy garde, et où

- Les **jetons et mots de passe** sont dans le **coffre de mots de passe du système** (Gestionnaire d'identification sous Windows, Trousseau sous macOS), jamais dans un fichier.
- Chaque envoi est noté dans le **journal** de Floppy (quoi, où, réussi ou non), jamais avec le contenu des secrets.
