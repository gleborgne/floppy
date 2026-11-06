# __ID__

Plugin pour Floppy : dit bonjour. *(Remplace ce texte.)*

Plugin for Floppy: says hello. *(Replace this text.)*

## Développer · Develop

```sh
floppy dev .             # lance Floppy avec ce plugin, rechargé à chaque sauvegarde
floppy tool __KEY___bonjour '{"nom":"Ada"}'   # appelle l'outil sans passer par le modèle
floppy plugin check .    # contrôles faits avant l'installation chez quelqu'un
floppy plugin test .     # essai dans un noyau jetable
```

## Installer · Install

```sh
floppy plugin install https://contoso.example/depot.git
```

Floppy fait relire le plugin par un agent IA, puis l'utilisateur l'installe d'un clic.
Floppy has the plugin reviewed by an AI agent, then the user installs it with a click.
