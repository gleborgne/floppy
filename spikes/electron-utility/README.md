# Spike P0 : noyau dans un utilityProcess d'Electron

Résultat du 2026-11-05 : **OK**.

- Electron 45.2.3 embarque Node 24.22.2.
- `node:sqlite` + FTS5 marche dans le `utilityProcess`.
- Lancer un processus enfant marche.
- Un fichier `.ts` est lancé directement (suppression des types de Node 24) : pas besoin de compiler le noyau en dev.
- `MessagePort` main ↔ utilityProcess marche.

Relancer : `npm install` puis `npx electron .` (et `npx electron main-ts.mjs`).
