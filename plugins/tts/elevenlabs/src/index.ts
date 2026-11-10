import { z } from "zod";
import { definePlugin, providerConfig, Pcm16Decoder, T, TextError } from "@floppy/core";
import { type TtsService } from "@floppy/contracts";
import { emotionNote } from "@floppy/toolkit";
import { deliveryText, playsEmotions } from "./expression.ts";

const Config = z.object({
  model: z.string().min(1).default("eleven_flash_v2_5"),
  voice: z.string().default(""),
  language: z.string().default(""),
});

export default definePlugin({
  manifest: {
    id: "tts-elevenlabs", version: "0.1.0", licence: "MIT", provides: ["tts"],
    description: "Synthèse vocale ElevenLabs en streaming.",
    sections: [{ id: "voice", label: { fr: "Voix", en: "Voice" } }],
    permissions: { cloud: true, net: ["api.elevenlabs.io"] },
    addable: { section: "voice", label: "ElevenLabs TTS", cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const account = providerConfig(ctx, { schema: Config, base: cfg, label: "ElevenLabs TTS", section: "voice", offers: "tts", validate: (v) => v.voice ? undefined : T("Identifiant de voix ElevenLabs manquant.", "ElevenLabs voice ID missing."), fields: [
      { key: "model", label: T("Modèle", "Model"), type: "text", required: true },
      { key: "voice", label: T("Identifiant de voix ElevenLabs", "ElevenLabs voice ID"), type: "text", required: true },
      { key: "language", label: T("Langue", "Language"), type: "text",
        hint: T("Code de langue (fr, en…). Vide : détection automatique.", "Language code (fr, en…). Empty: automatic detection.") },
    ] });
    const active = new Set<AbortController>();
    ctx.effect(() => { for (const a of active) a.abort(); });
    const service: TtsService = {
      name: "ElevenLabs",
      availability: account.availability,
      async *speak(text, opts) {
        if (!ctx.alive) throw new Error("Fournisseur ElevenLabs déchargé");
        const cfg = account.config();
        const voice = cfg.voice;
        if (!voice) throw new TextError(T("Renseigne l'identifiant de voix ElevenLabs dans les réglages.", "Enter the ElevenLabs voice ID in the settings."));
        const abort = new AbortController(); active.add(abort);
        const signal = AbortSignal.any([opts.signal, abort.signal, AbortSignal.timeout(60_000)]);
        try {
          const response = await ctx.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`, {
            method: "POST", signal,
            headers: { "xi-api-key": account.apiKey(), "content-type": "application/json" },
            body: JSON.stringify({ text: deliveryText(text, cfg.model, opts.delivery), model_id: cfg.model, ...(cfg.language ? { language_code: cfg.language } : {}) }),
          });
          if (!response.ok || !response.body) throw new Error(`ElevenLabs TTS : erreur HTTP ${response.status}`);
          const decoder = new Pcm16Decoder();
          for await (const bytes of response.body) {
            signal.throwIfAborted();
            const pcm = decoder.push(bytes);
            if (pcm.length) yield { rate: 24000, pcm };
          }
          decoder.finish();
        } finally { active.delete(abort); }
      },
    };
    // Le compte est une voix qu'on active (slot voice.tts) : le noyau la met en service seulement en mode Séparé.
    ctx.offer("tts", {
      items: () => [{ id: "account", label: `${service.name} · ${account.config().voice || "?"}`, cloud: true,
        // Relu à chaque affichage de la liste : suit le modèle choisi dans les réglages.
        note: emotionNote(playsEmotions(account.config().model), T("il faut un modèle v3 ou v4", "a v3 or v4 model is needed")) }],
      start(f) {
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Fournisseur non configuré", "Provider not configured"));
        f.provide("tts", service);
      },
    });
  },
});
