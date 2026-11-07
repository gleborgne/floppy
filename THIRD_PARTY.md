# Third-party components

Floppy's code is under the [MIT licence](LICENSE). It uses components with their own licences.

## Included in this repository

| Component | Where | Licence |
|---|---|---|
| [Lucide](https://lucide.dev) icons (from `lucide-static`) | `apps/desktop/src/renderer/icons.js` | ISC |
| [Simple Icons](https://simpleicons.org) brand logos (Obsidian, Claude, SearXNG) | `plugins/tools/mcp/src/logos.ts`, `plugins/tools/websearch/src/logo.ts`, `plugins/tools/searxng/src/logo.ts` | CC0 1.0 (the brands remain trademarks of their owners) |
| Azure DevOps icon ([Azure Architecture Icons](https://learn.microsoft.com/azure/architecture/icons/), Microsoft) | `plugins/tools/mcp/src/logos.ts` | Microsoft terms of use: only to represent Azure DevOps, next to its name, unmodified |
| SIWIS French Speech Synthesis Database (two sentences, 24 kHz) | `plugins/tts/audiocpp/voices/ref_fr_siwis.wav` | CC BY 4.0 — see [CREDITS](plugins/tts/audiocpp/voices/CREDITS.md) |

npm dependencies are checked by `npm run licences` (part of `npm run check`): only permissive licences are allowed in shipped packages.

## Downloaded by you (not included)

Models are downloaded on first use or added by you. You must accept each model's licence.
Check the licence on the model page before use: it can change between versions.

| Model | Used for | Licence (at the time of writing) |
|---|---|---|
| Gemma 4 (Google) | Local brain (suggested) | Apache 2.0 |
| Qwen3 / Qwen3-TTS (Alibaba) | Local brain, voice (GPU) | Apache 2.0 |
| Parakeet TDT 0.6B v3 (NVIDIA) | Speech-to-text | CC BY 4.0 |
| Pocket TTS (Kyutai) | Local voice on the CPU (voice cloning) | CC BY 4.0 |
| Supertonic 3 (Supertone) | Local voice on the CPU (preset voices) | OpenRAIL-M |
| Silero VAD | Voice activity detection | MIT |

Cloud providers (Google Gemini, OpenAI, ElevenLabs, Picovoice, Microsoft Graph, Azure DevOps…) are used only when you enable their plugin, under their own terms.
