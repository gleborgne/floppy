// Programme audiocpp_server (audio.cpp) prêt à télécharger, une archive par système et par moteur.
// Fichier généré à partir de la version v0.9.4 (API GitHub) : garder les tailles et empreintes telles quelles.
// Pour changer de version : régénérer toutes les lignes, puis vérifier au moins une archive sur une vraie machine.
import { T } from "@floppy/core";
import type { ProgramBuild } from "@floppy/setup";

export const AUDIOCPP_VERSION = "v0.9.4";

export const AUDIOCPP_BUILDS: ProgramBuild[] = [
  {
    id: "v0.9.4-win-cuda13-x64", label: T("CUDA 13 (cartes NVIDIA récentes)", "CUDA 13 (recent NVIDIA cards)"), os: "windows", arch: "x64", backend: "cuda", minDriver: 580,
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-cuda13.3.zip", size: 279188412, sha256: "b05eceb8aa0a29e618b3af87e0c2fd0fb665034d181096eb868ed856bf656b8b" },
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-cudart-windows-x64-cuda13.3.zip", size: 575457454, sha256: "b93fa9b9cb875ccea1aa81cb09fd6b02c9afda133de73bd119a73ff5d8db6d96" },
    ],
  },
  {
    id: "v0.9.4-win-cuda12-x64", label: T("CUDA 12 (cartes NVIDIA)", "CUDA 12 (NVIDIA cards)"), os: "windows", arch: "x64", backend: "cuda", minDriver: 552,
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-cuda12.4.zip", size: 467800419, sha256: "e85d829e121a424a960d9ad293536b7ada74ea845b1c12fcf2991ec09a224d1e" },
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-cudart-windows-x64-cuda12.4.zip", size: 607273675, sha256: "efb58667b95bcb32e89ddf87811664e6ffdced3fe7015ddcc077599ed5f44bb2" },
    ],
  },
  {
    id: "v0.9.4-win-vulkan-x64", label: T("Vulkan (AMD, Intel, NVIDIA)", "Vulkan (AMD, Intel, NVIDIA)"), os: "windows", arch: "x64", backend: "vulkan",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-vulkan-portable.zip", size: 83953489, sha256: "295ca309160e59ec3ce3cff0e07edb6709e28d43b4c0a5ad76760938ae6a4e5c" },
    ],
  },
  {
    id: "v0.9.4-win-cpu-x64", label: T("processeur seulement", "processor only"), os: "windows", arch: "x64", backend: "cpu",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-cpu-portable.zip", size: 32190461, sha256: "9c11a03b7ea21979792fde05f2f355ea1fc0da26ccd8f675dd61c628250ae76f" },
    ],
  },
  {
    id: "v0.9.4-mac-arm64", label: T("Metal (puce Apple)", "Metal (Apple chip)"), os: "mac", arch: "arm64", backend: "metal",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-macos-arm64-metal.tar.gz", size: 36947118, sha256: "5722c4f33e56114345965c0dee472a9239218f7499ace6393bba6a951a41b86a" },
    ],
  },
  {
    id: "v0.9.4-mac-x64", label: T("Metal", "Metal"), os: "mac", arch: "x64", backend: "metal",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-macos-x64-metal.tar.gz", size: 39330776, sha256: "be2a35aa004cc3d63978c77723ee3f2805129eedf726172c45145ef114664451" },
    ],
  },
  {
    id: "v0.9.4-linux-vulkan-x64", label: T("Vulkan (AMD, Intel, NVIDIA)", "Vulkan (AMD, Intel, NVIDIA)"), os: "linux", arch: "x64", backend: "vulkan",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-ubuntu-x64-vulkan-portable.tar.gz", size: 87776393, sha256: "82808683beb5da2987abbdca5ba3b93622eb93568eda8d92acf1f7314a26dbab" },
    ],
  },
  {
    id: "v0.9.4-linux-cpu-x64", label: T("processeur seulement", "processor only"), os: "linux", arch: "x64", backend: "cpu",
    files: [
      { url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-ubuntu-x64-cpu-portable.tar.gz", size: 70154506, sha256: "02756c556d78ccca8040cab6fbc6c7bf57d4f6ed70fe534e8a9e846bab464687" },
    ],
  },
];
