// Modèles GGUF choisis pour le cerveau (Réglages → Cerveau → Télécharger des modèles). Testés avec llama-server.
// Adresses figées (commit Hugging Face) et empreintes sha256 : un fichier changé est refusé.
import { T } from "@floppy/core";
import type { LibraryEntry } from "@floppy/setup";
import { ggufNeeds, memoryTag } from "./hf.ts";

const hf = (repo: string, commit: string, file: string, size: number, sha256: string) =>
  ({ url: `https://huggingface.co/${repo}/resolve/${commit}/${file}`, path: `hf/${repo}/${file}`, size, sha256 });

const entry = (e: Omit<LibraryEntry, "tags"> & { tags: LibraryEntry["tags"] }): LibraryEntry =>
  ({ ...e, tags: [...(e.tags ?? []), memoryTag(e.files[0]!.size!)], needs: ggufNeeds(e.files[0]!.size!) });

export const KNOWN_MODELS: LibraryEntry[] = [
  entry({
    id: "qwen3.5-4b-q4km", label: "Qwen3.5 4B · Q4_K_M",
    description: T("Petit et rapide, bon en français. Pour une petite carte graphique.", "Small and fast, good in French. For a small graphics card."),
    licence: { name: "Apache-2.0", url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF" },
    tags: [T("outils", "tools")],
    files: [hf("unsloth/Qwen3.5-4B-GGUF", "e87f176479d0855a907a41277aca2f8ee7a09523", "Qwen3.5-4B-Q4_K_M.gguf", 2_740_937_888, "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4")],
  }),
  entry({
    id: "gemma-4-e4b-q4_0", label: "Gemma 4 E4B · Q4_0 (QAT)",
    description: T("Léger et vif, très bon en français. Quantifié par Google sans perte notable.", "Light and quick, very good in French. Quantized by Google with no notable loss."),
    licence: { name: "Apache-2.0", url: "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf" },
    tags: [],
    files: [hf("google/gemma-4-E4B-it-qat-q4_0-gguf", "4b4a2c1d584be7264f87aac328a1bc739ce81b6c", "gemma-4-E4B_q4_0-it.gguf", 5_154_941_280, "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee")],
  }),
  entry({
    id: "qwen3.5-9b-q4km", label: "Qwen3.5 9B · Q4_K_M",
    description: T("Réfléchit plus, utilise bien les outils. Un bon cerveau principal.", "Thinks more, uses tools well. A good main brain."),
    licence: { name: "Apache-2.0", url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF" },
    tags: [T("outils", "tools")],
    files: [hf("unsloth/Qwen3.5-9B-GGUF", "3885219b6810b007914f3a7950a8d1b469d598a5", "Qwen3.5-9B-Q4_K_M.gguf", 5_680_522_464, "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8")],
  }),
  entry({
    id: "gemma-4-12b-q4_0", label: "Gemma 4 12B · Q4_0 (QAT)",
    description: T("Le meilleur équilibre en français pour une carte graphique moyenne.", "The best balance in French for a mid-range graphics card."),
    licence: { name: "Apache-2.0", url: "https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf" },
    tags: [],
    files: [hf("google/gemma-4-12B-it-qat-q4_0-gguf", "29d097773436b69ff9feafd636ab4cf873786537", "gemma-4-12b-it-qat-q4_0.gguf", 6_975_879_296, "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b")],
  }),
  entry({
    id: "mistral-small-3.2-q4km", label: "Mistral Small 3.2 24B · Q4_K_M",
    description: T("Très bon en français et avec les outils. Demande une grosse carte graphique.", "Very good in French and with tools. Needs a large graphics card."),
    licence: { name: "Apache-2.0", url: "https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF" },
    tags: [T("outils", "tools")],
    files: [hf("unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF", "b750ec2299225e492f1bd27cab88a0a595fa848f", "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf", 14_333_922_848, "a3cc56310807ed0d145eaf9f018ccda9ae7ad8edb41ec870aa2454b0d4700b3c")],
  }),
];
