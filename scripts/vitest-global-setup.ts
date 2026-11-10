// Electron 45 ne télécharge plus son programme à l'installation (npm ci) : il le fait au premier
// require("electron"). Sur une copie neuve (la CI GitHub), deux fichiers de test qui lancent Electron
// en même temps téléchargent ensemble et se gênent (EBUSY, « Electron failed to install correctly »).
// On le demande donc une fois ici, avant que les tests partent en parallèle.
import { createRequire } from "node:module";

export default function setup(): void {
  createRequire(import.meta.url)("electron");
}
