import { z } from "zod";
import { definePlugin, providerConfig, connectJsonSocket, floatToPcm16, Pcm16Decoder, T, TextError, tr, type LiveService, type LiveSession } from "@floppy/core";

const Config = z.object({ model: z.string().regex(/^[\w.-]+$/).default("gemini-3.8-live"), voice: z.string().min(1).default("Kore") });

export default definePlugin({
  manifest: {
    id: "live-gemini", version: "0.1.0", licence: "MIT", provides: ["live"],
    description: "Conversation audio native Gemini Live.",
    sections: [{ id: "cerveau", label: { fr: "Cerveau", en: "Brain" } }],
    permissions: { cloud: true, net: ["generativelanguage.googleapis.com"] },
    addable: { section: "cerveau", label: "Gemini Live", cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const account = providerConfig(ctx, { schema: Config, base: cfg, label: "Gemini Live", section: "cerveau", capabilities: ["live"], offers: "live", fields: [
      { key: "model", label: T("Modèle Live", "Live model"), type: "text", required: true }, { key: "voice", label: T("Voix Gemini", "Gemini voice"), type: "text", required: true },
    ] });
    const sessions = new Set<LiveSession>();
    const lifetime = new AbortController();
    ctx.effect(async () => { lifetime.abort(); await Promise.allSettled([...sessions].map((s) => s.close())); });
    // Langue de l'assistant : messages dits ou montés de la session (les plugins redémarrent quand elle change).
    const lang = ctx.assistant.language;
    const say = (fr: string, en: string) => tr(T(fr, en), lang);
    const service: LiveService = {
      name: "Gemini Live", availability: account.availability, capabilities: { tools: "function" },
      async open(opts) {
        if (!ctx.alive) throw new Error("Fournisseur Gemini Live déchargé");
        const cfg = account.config();
        let generation = 0;
        let decoder = new Pcm16Decoder();
        let closed = false;
        let session: LiveSession | undefined;
        const socket = await connectJsonSocket({
          url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(account.apiKey())}`,
          signal: AbortSignal.any([opts.signal, lifetime.signal]), ready: (e) => !!e.setupComplete,
          start: { setup: {
            model: `models/${cfg.model}`, generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } } },
            systemInstruction: { parts: [{ text: lang === "en" ? `${opts.instructions}\nLanguage: always speak English.` : opts.instructions }] },
            inputAudioTranscription: {}, outputAudioTranscription: {},
            tools: opts.tools.length ? [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema, behavior: "BLOCKING" })) }] : [],
          } },
          closed: (reason) => { if (!closed) { closed = true; if (session) sessions.delete(session); opts.on({ type: "closed", reason }); } },
          on(e) {
            if (e.error) { opts.on({ type: "error", message: say("Gemini Live : erreur de session", "Gemini Live: session error"), fatal: true }); return { close: "Gemini Live : session refusée" }; }
            const content = e.serverContent;
            if (content?.interrupted) { decoder = new Pcm16Decoder(); opts.on({ type: "interrupted", generation: ++generation }); }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (!part.inlineData) continue;
              const mime = String(part.inlineData.mimeType ?? "");
              if (!/^audio\/(pcm|L16)/i.test(mime)) throw new Error("Audio Live non PCM");
              const pcm = decoder.push(Buffer.from(part.inlineData.data, "base64"));
              if (pcm.length) opts.on({ type: "audio", generation, pcm, rate: Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000) });
            }
            // Pas de dépendance à un champ « finished » : l'orchestrateur dispose aussi du STT local et de la lecture.
            if (content?.inputTranscription) opts.on({ type: "input_transcript", text: content.inputTranscription.text ?? "", final: false });
            if (content?.outputTranscription) opts.on({ type: "output_transcript", text: content.outputTranscription.text ?? "", final: false });
            if (content?.turnComplete) { opts.on({ type: "generation_done" }); generation++; }
            for (const call of e.toolCall?.functionCalls ?? []) opts.on({ type: "tool_call", id: call.id, name: call.name, args: call.args ?? {} });
            if (e.toolCallCancellation) opts.on({ type: "tool_cancelled", ids: e.toolCallCancellation.ids ?? [] });
            if (e.goAway) opts.on({ type: "error", message: say("Gemini termine cette session. Réactive Floppy pour reprendre.", "Gemini is ending this session. Wake Floppy again to continue.") });
          },
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Connexion Gemini Live impossible";
          if (/prepayment credits are depleted/i.test(message)) throw new TextError(T("Gemini Live : crédits prépayés épuisés. Recharge le projet dans Google AI Studio ou utilise la clé d'un projet crédité.", "Gemini Live: prepaid credits are used up. Top up the project in Google AI Studio or use the key of a funded project."));
          throw error;
        });
        if (!ctx.alive || opts.signal.aborted) { await socket.close(); throw new Error("Session annulée pendant la connexion"); }
        const opened: LiveSession = {
          pushAudio: (frame) => { if (!closed) socket.send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: floatToPcm16(frame).toString("base64") } } }); },
          toolResult: (id, name, result) => { if (!closed) socket.send({ toolResponse: { functionResponses: [{ id, name, response: result }] } }); },
          append: (kind, text) => { if (!closed) socket.send({ clientContent: { turns: [{ role: "user", parts: [{ text: kind === "say" ? say(`Annonce de l'application à lire : ${text}`, `App announcement to read aloud: ${text}`) : say(`Contexte de l'application (${kind}) : ${text}`, `App context (${kind}): ${text}`) }] }], turnComplete: kind === "say" } }); },
          close: async () => { closed = true; sessions.delete(opened); await socket.close(); },
        };
        session = opened; sessions.add(opened);
        return opened;
      },
    };
    // Le compte est un moteur Live qu'on active (slot conversation.live) : le noyau l'ouvre seulement en mode Live.
    ctx.offer("live", {
      items: () => [{ id: "account", label: "Gemini Live", cloud: true }],
      start(f) {
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Fournisseur non configuré", "Provider not configured"));
        f.provide("live", service);
      },
    });
  },
});
