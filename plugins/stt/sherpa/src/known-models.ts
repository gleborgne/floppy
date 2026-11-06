// Modèles sherpa-onnx proposés au téléchargement (Réglages → Écoute → Télécharger des modèles).
// Adresses figées (version GitHub, commit Hugging Face) et empreintes sha256 : un fichier changé est refusé.
import { T, type LibraryEntry } from "@floppy/core";

export interface KnownModel extends LibraryEntry {
  /** Ce que l'élément ajouté désigne, relatif au dossier des téléchargements : le fichier (détecteur) ou le dossier (transcription). */
  target: string;
}

const PARAKEET = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78";

export const KNOWN_MODELS: KnownModel[] = [
  {
    id: "silero-vad",
    label: T("Silero VAD (détecteur de parole)", "Silero VAD (speech detector)"),
    description: T("Repère quand tu commences et finis de parler. Petit et rapide : indispensable pour l'écoute.",
      "Detects when you start and stop speaking. Small and fast: needed for listening."),
    licence: { name: "MIT", url: "https://github.com/snakers4/silero-vad/blob/master/LICENSE" },
    tags: [T("processeur", "CPU")],
    target: "silero-vad/silero_vad.onnx",
    files: [{
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
      path: "silero-vad/silero_vad.onnx", size: 643_854,
      sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    }],
  },
  {
    id: "parakeet-tdt-v3-int8",
    label: T("Parakeet TDT v3 (transcription)", "Parakeet TDT v3 (transcription)"),
    description: T("Transforme ta voix en texte, en français, en anglais et dans 23 autres langues d'Europe. Tourne sur le processeur.",
      "Turns your voice into text, in French, English and 23 other European languages. Runs on the CPU."),
    licence: { name: "CC-BY-4.0", url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" },
    tags: [T("français", "French"), T("anglais", "English"), T("processeur", "CPU")],
    target: "parakeet-tdt-v3-int8",
    files: [
      { url: `${PARAKEET}/encoder.int8.onnx`, path: "parakeet-tdt-v3-int8/encoder.int8.onnx", size: 652_184_281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
      { url: `${PARAKEET}/decoder.int8.onnx`, path: "parakeet-tdt-v3-int8/decoder.int8.onnx", size: 11_845_275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
      { url: `${PARAKEET}/joiner.int8.onnx`, path: "parakeet-tdt-v3-int8/joiner.int8.onnx", size: 6_355_277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
      { url: `${PARAKEET}/tokens.txt`, path: "parakeet-tdt-v3-int8/tokens.txt", size: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
    ],
  },
];
