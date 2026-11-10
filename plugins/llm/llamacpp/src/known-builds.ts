// Programme llama-server (llama.cpp) prêt à télécharger, une archive par système et par moteur.
// Fichier généré à partir de la version b12177 (API GitHub) : garder les tailles et empreintes telles quelles.
// Pour changer de version : régénérer toutes les lignes, puis vérifier au moins une archive sur une vraie machine.
import { T } from "@floppy/core";
import type { ProgramBuild } from "@floppy/setup";

export const LLAMA_VERSION = "b12177";

export const LLAMA_BUILDS: ProgramBuild[] = [
  {
    id: "b12177-win-cuda13-x64", label: T("CUDA 13 (cartes NVIDIA récentes)", "CUDA 13 (recent NVIDIA cards)"), os: "windows", arch: "x64", backend: "cuda", minDriver: 580,
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-cuda-13.5-x64.zip", size: 170766145, sha256: "a985ee38a17bdd4004ea5d2fcdd57bcfb7449eba0908cc7a08304d183e74b744" },
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/cudart-llama-bin-win-cuda-13.5-x64.zip", size: 426314199, sha256: "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba" },
    ],
  },
  {
    id: "b12177-win-cuda12-x64", label: T("CUDA 12 (cartes NVIDIA)", "CUDA 12 (NVIDIA cards)"), os: "windows", arch: "x64", backend: "cuda", minDriver: 552,
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-cuda-12.4-x64.zip", size: 288720825, sha256: "f1a0ea8c2dc8caa592e4f7d279eecf0d750cec187267cb60b7f2f28ec01ad194" },
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/cudart-llama-bin-win-cuda-12.4-x64.zip", size: 391443627, sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6" },
    ],
  },
  {
    id: "b12177-win-vulkan-x64", label: T("Vulkan (AMD, Intel, NVIDIA)", "Vulkan (AMD, Intel, NVIDIA)"), os: "windows", arch: "x64", backend: "vulkan",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-vulkan-x64.zip", size: 37706753, sha256: "84f0a856431ba9c97eb73a03601f68ce3d509d0eda010ca30a71d3243124ac32" },
    ],
  },
  {
    id: "b12177-win-cpu-x64", label: T("processeur seulement", "processor only"), os: "windows", arch: "x64", backend: "cpu",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-cpu-x64.zip", size: 24745639, sha256: "2d53212b57ccfc50128ec2e704c8ae44fb12df5206a731eef7be63f7669ebc74" },
    ],
  },
  {
    id: "b12177-win-vulkan-arm64", label: T("Vulkan", "Vulkan"), os: "windows", arch: "arm64", backend: "vulkan",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-vulkan-arm64.zip", size: 25755844, sha256: "5ffac330323c3aa32fdbab6859ac7c0af85be06aa813c3f8e235b5eefd3f4a33" },
    ],
  },
  {
    id: "b12177-win-cpu-arm64", label: T("processeur seulement", "processor only"), os: "windows", arch: "arm64", backend: "cpu",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-win-cpu-arm64.zip", size: 13222862, sha256: "641cf8647fa0f52cddefc967f44f94b3c5d7108782830afc4f5833d4b976f9f8" },
    ],
  },
  {
    id: "b12177-mac-arm64", label: T("Metal (puce Apple)", "Metal (Apple chip)"), os: "mac", arch: "arm64", backend: "metal",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-macos-arm64.tar.gz", size: 16694718, sha256: "618c2cbbe89338501d293488de52143f5d9173d4a63e932a1dc7ea5777d2fcb5" },
    ],
  },
  {
    id: "b12177-mac-x64", label: T("processeur seulement", "processor only"), os: "mac", arch: "x64", backend: "cpu",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-macos-x64.tar.gz", size: 12432627, sha256: "ba4ca623cf8819124b0b7667ac465ac557cee5c6070b2065f8348c2d8f6e3bdd" },
    ],
  },
  {
    id: "b12177-linux-vulkan-x64", label: T("Vulkan (AMD, Intel, NVIDIA)", "Vulkan (AMD, Intel, NVIDIA)"), os: "linux", arch: "x64", backend: "vulkan",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-ubuntu-vulkan-x64.tar.gz", size: 35857298, sha256: "9b1e56f828ad3164b52f4c33946d495b3274e02dba94f569d2d168d5e8e218c2" },
    ],
  },
  {
    id: "b12177-linux-cpu-x64", label: T("processeur seulement", "processor only"), os: "linux", arch: "x64", backend: "cpu",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-ubuntu-x64.tar.gz", size: 23046816, sha256: "5d936162de06187654d1353fe94d65390904f1c67cd1a887023dbc9b0b207284" },
    ],
  },
  {
    id: "b12177-linux-vulkan-arm64", label: T("Vulkan", "Vulkan"), os: "linux", arch: "arm64", backend: "vulkan",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-ubuntu-vulkan-arm64.tar.gz", size: 29181885, sha256: "95badc10b09b2853369f1d4724cd78ed8dba7a1847cbfb2011669ead3f84d6cc" },
    ],
  },
  {
    id: "b12177-linux-cpu-arm64", label: T("processeur seulement", "processor only"), os: "linux", arch: "arm64", backend: "cpu",
    files: [
      { url: "https://github.com/ggml-org/llama.cpp/releases/download/b12177/llama-b12177-bin-ubuntu-arm64.tar.gz", size: 18731445, sha256: "2ef14032b3b25f4d10b01b3861b9539756cac4af421919f1b8da56c9a7df4b8f" },
    ],
  },
];
