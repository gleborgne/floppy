# Questions ouvertes

[← Retour à la spec](README.md)

1. **Nom du projet** open source.
2. **Licences des modèles** par défaut, compatibles avec un projet MIT et un usage par d'autres : Gemma 4 (Apache-2.0), Qwen3-TTS, Parakeet, licence du détecteur de fin de tour LiveKit. LFM Open v1.0 (LFM3, d1-2B) est exclue. Le code est MIT, mais l'utilisateur doit accepter la licence de chaque modèle.
3. **Moteur du mot d'activation** : openWakeWord (local, à entraîner pour un mot configurable) ou reconnaissance par transcription (actuel). Le mot doit être configurable et peu gourmand.
4. **Sandbox Windows** pour les plugins hors processus : jeton restreint + ACL (comme DeepSeek Harness), ou plus simple pour la v1.
5. ~~**Format exact du protocole** noyau ↔ corps~~ : v0 fait, voir [Corps, émotions et avatar](corps-et-avatar.md#le-protocole-noyau--corps-v0). Reste : versionner et documenter les adaptateurs Reachy et Telegram.
6. **Silence pendant la délégation** : après la phrase d'attente (~0,7 s), il reste ~5 s de silence avant la réponse de Sonnet. Faut-il un petit son, ou une 2ᵉ phrase ? (Demandes ambiguës : réglé par le prototype 4.)
7. **Modèles live (Gemini Live, GPT Live)** :
   - Mode séparé : vérifier qu'on peut couper leur propre raisonnement (transcription seule, ou lecture d'un texte fourni) sans perdre la fluidité.
   - Mode live : vérifier la mise à jour des instructions (mémoire, ton) pendant une session, le délai des appels d'outils qui reviennent au noyau, et la durée maximale d'une session.
8. **Mémoire dans Obsidian ?** La mémoire vit dans le dossier de l'assistant. Faut-il la rendre visible dans le coffre Obsidian (lien ou copie), et comment ?
9. **Cerveau cloud** : quels fournisseurs proposer par clé API, et quelle limite de dépenses par défaut ?
10. **Mode abonnement** (CLI Claude ou Codex) dans un projet open source : demander l'avis d'Anthropic, et regarder le partenariat « Sign in with ChatGPT » d'OpenAI. Voir [Le cerveau](cerveau.md#abonnement-ou-clé-api--conditions-dutilisation).
