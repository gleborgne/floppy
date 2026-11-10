import { z } from "zod";
import { definePlugin, providerConfig, readSse, Pcm16Decoder, T, TextError } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import { emotionNote, speechInstructions } from "@floppy/toolkit";

const Config = z.object({
  model: z.string().regex(/^[\w.-]+$/).default("gemini-3.1-flash-tts-preview"),
  voice: z.string().min(1).default("Kore"),
});

export default definePlugin({
  manifest: {
    id: "tts-gemini", version: "0.1.0", licence: "MIT", provides: ["tts"],
    description: "Synthèse vocale Gemini en streaming (modèles TTS 3.1 et suivants).",
    sections: [{ id: "voix", label: { fr: "Voix", en: "Voice" } }],
    permissions: { cloud: true, net: ["generativelanguage.googleapis.com"] },
    addable: { section: "voix", label: "Gemini TTS", cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const account = providerConfig(ctx, { schema: Config, base: cfg, label: "Gemini TTS", section: "voix", offers: "tts", fields: [
      { key: "model", label: T("Modèle TTS (3.1 ou suivant)", "TTS model (3.1 or later)"), type: "text", required: true },
      { key: "voice", label: T("Voix Gemini", "Gemini voice"), type: "text", required: true },
    ] });
    const active = new Set<AbortController>();
    ctx.effect(() => { for (const a of active) a.abort(); });
    const service: TtsService = {
      name: "Gemini TTS",
      availability: account.availability,
      async *speak(text, opts) {
        if (!ctx.alive) throw new Error("Fournisseur Gemini TTS déchargé");
        const cfg = account.config();
        const abort = new AbortController(); active.add(abort);
        const signal = AbortSignal.any([opts.signal, abort.signal, AbortSignal.timeout(60_000)]);
        try {
          const response = await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse`, {
            method: "POST", signal,
            headers: { "x-goog-api-key": account.apiKey(), "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: [
                "Synthesize speech.",
                opts.delivery ? speechInstructions(opts.delivery) : "",
                opts.delivery?.language === "fr"
                  ? "Parle en français, avec un débit régulier et des pauses naturelles. Lis uniquement la transcription suivante, sans la modifier :"
                  : "Speak with a steady pace and natural pauses. Read only the following transcript, exactly as written:",
                text,
              ].join("\n\n") }] }],
              generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } } },
            }),
          });
          if (!response.ok || !response.body) throw new Error(`Gemini TTS : erreur HTTP ${response.status}`);
          const decoder = new Pcm16Decoder();
          let heard = false;
          let completed = false;
          for await (const value of readSse(response.body)) {
            signal.throwIfAborted();
            const event = value as { error?: unknown; candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[] };
            if (event.error) throw new TextError(T("Gemini TTS a refusé la génération.", "Gemini TTS refused to generate."));
            const finish = event.candidates?.[0]?.finishReason;
            if (finish && finish !== "STOP") throw new Error("Gemini TTS : génération interrompue par le fournisseur");
            completed ||= finish === "STOP";
            for (const part of event.candidates?.[0]?.content?.parts ?? []) {
              if (!part.inlineData) continue;
              const { data, mimeType } = part.inlineData;
              if (!/^audio\/(L16|pcm)(;|$)/i.test(mimeType)) throw new Error("Gemini TTS : format PCM attendu");
              const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
              if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) throw new Error("Gemini TTS : taux audio invalide");
              const pcm = decoder.push(Buffer.from(data, "base64"));
              if (pcm.length) { heard = true; yield { rate, pcm }; }
            }
          }
          decoder.finish();
          if (!heard) throw new TextError(T("Gemini TTS n'a retourné aucun audio.", "Gemini TTS returned no audio."));
          if (!completed) throw new Error("Gemini TTS : flux incomplet, fin de génération non confirmée");
        } finally { active.delete(abort); }
      },
    };
    // Le compte est une voix qu'on active (slot voice.tts) : le noyau la met en service seulement en mode Séparé.
    ctx.offer("tts", {
      items: () => [{ id: "account", label: `${service.name} · ${account.config().voice || "?"}`, cloud: true, note: emotionNote(true) }],
      start(f) {
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Fournisseur non configuré", "Provider not configured"));
        f.provide("tts", service);
      },
    });
  },
});
