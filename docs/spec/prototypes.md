# Réutilisation des prototypes

[← Retour à la spec](README.md)

| Prototype | Réutilisé pour |
|---|---|
| `cascade\pipeline.py` | Fournisseur `voice` « cascade locale » : VAD, ASR (Parakeet, Qwen3-ASR + graphe CUDA), TTS (faster-qwen3-tts, Anna), phrases recollées, interruption. |
| `cascade\s2s_serve.py` | Idées : voix imposée par le serveur, mot d'activation côté serveur. |
| `cascade\scripts\bench_stt.py`, `compare_voices.py` | Bancs de test des fournisseurs ASR et TTS. |
| `prototypes\frameworks\aisdk\agent.ts`, `common\` | Base du cerveau : agent AI SDK, client MCP, accord des outils, prompt v2. |
| `prototypes\local-models\eval.py`, `work_mcp\server.py`, `prototypes\decision\cases_new.py` | Banc de test du cerveau : faux serveur MCP de travail et 40 demandes notées. |
| `prototypes\cli-brain\src\` | Serveur MCP « Floppy », adaptateurs CLI Claude et Codex, délégation depuis Gemma. |
| `prototypes\bridge\` | Tests d'attaque à refaire sur notre noyau (jeton, refus par défaut). |
| `lfm3\` | Référence pour LFM3 (outils natifs, format `<tool_call>`). Plus utilisé : licence incompatible. |
| `reachy\reachy_body\moves.py` | Outils « corps » du futur corps Reachy. |
| `start-reachy-cascade.ps1` | Idées pour le lancement et l'arrêt des services (fenêtres, ports, relance). |

## Repris dans le proto (5 novembre 2026)

| Prototype | Devenu |
|---|---|
| `prototypescli-brainsrcloppy-mcp.ts` | `assistantplugins	oolsmcp` (le contrôle des accords est passé dans le registre d'outils du noyau) |
| `prototypescli-brainsrcrains.ts` (Claude) | `assistantpluginsrainclaude-cli` |
| `prototypescli-brainsrcagent-a.ts` + `prototypesambiguitysrc` (v3c) | `assistantpluginsrainaisdk` |
| `prototypescli-brainsrcserve.ts`, `eval_cli.py` | `assistantpluginsdevench-api`, `assistantench` |
| `cascadepipeline.py` (moteurs), `cascadeapp.py` (tour) | `assistantservicesoiceserver.py` (importe les moteurs de cascade tels quels) |
| `cascadestaticindex.html` (micro, lecture) | `assistantappsdesktopsrcendererapp.js` |
