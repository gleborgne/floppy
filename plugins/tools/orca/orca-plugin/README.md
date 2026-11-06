# Plugin Orca « Floppy »

Prévient Floppy dès qu'un agent Orca change d'état (au lieu d'attendre la vérification suivante de Floppy).

Installation, une fois :

```
orca plugin dev load plugins/tools/orca/orca-plugin
```

Orca affiche une empreinte. Relancez la même commande avec `--approve <empreinte>`.
Le plugin demande seulement d'être prévenu des changements d'état des agents (`agent:read`).

Journal : `orca plugin logs local.floppy`. Fonctionnement : `docs/spec/outils-reels.md`, section « Pont ».
