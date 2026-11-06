import { randomUUID } from "node:crypto";
import { z } from "zod";
import { definePlugin, providerConfig, connectJsonSocket, floatToPcm16, Pcm16Decoder, T, TextError, tr, type LiveService, type LiveSession } from "@floppy/core";

const Config = z.object({ model: z.string().min(1).default("gpt-live-1"), voice: z.string().min(1).default("marin") });

export default definePlugin({
  manifest: {
    id: "live-openai", version: "0.1.0", licence: "MIT", provides: ["live"],
    description: "GPT Live : voix native avec délégation au cerveau de l'application.",
    sections: [{ id: "cerveau", label: { fr: "Cerveau", en: "Brain" } }],
    permissions: { cloud: true, net: ["api.openai.com"] },
    addable: { section: "cerveau", label: "GPT Live", cloud: true, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const account = providerConfig(ctx, { schema: Config, base: cfg, label: "GPT Live", section: "cerveau", capabilities: ["live"], offers: "live", fields: [
      { key: "model", label: T("Modèle Live", "Live model"), type: "text", required: true }, { key: "voice", label: T("Voix GPT Live", "GPT Live voice"), type: "text", required: true },
    ] });
    const sessions = new Set<LiveSession>();
    const lifetime = new AbortController();
    ctx.effect(async () => { lifetime.abort(); await Promise.allSettled([...sessions].map((s) => s.close())); });
    // Langue de l'assistant : messages de la session (les plugins redémarrent quand elle change).
    const lang = ctx.assistant.language;
    const say = (fr: string, en: string) => tr(T(fr, en), lang);
    const service: LiveService = {
      name: "GPT Live", availability: account.availability, capabilities: { tools: "delegation" },
      async open(opts) {
        if (!ctx.alive) throw new Error("Fournisseur GPT Live déchargé");
        const cfg = account.config();
        const decoder = new Pcm16Decoder();
        let closed = false;
        let session: LiveSession | undefined;
        let started = false;
        const socket = await connectJsonSocket({
          url: "wss://api.openai.com/v1/live/sessions", headers: { Authorization: `Bearer ${account.apiKey()}` },
          signal: AbortSignal.any([opts.signal, lifetime.signal]), ready: (e) => { if (e.type === "session.started") started = true; return started; },
          start: { type: "session.start", session: {
            model: cfg.model, instructions: `${opts.instructions}${lang === "en" ? "\nLanguage: always speak English." : ""}\nBackchannel policy: Use brief, sparse listening acknowledgments.\nInterruption policy: Stop speaking when interrupted and listen.\nDelegation policy: Generate <|SpawnThinking|> for requests requiring tools, external information, or complex reasoning. The client backend handles all actions and permissions. Relay its results faithfully.`,
            audio: { format: { type: "audio/pcm", rate: 16000 }, output: { voice: cfg.voice } },
            delegation: { type: "client" },
          } },
          closed: (reason) => { if (!closed) { closed = true; if (session) sessions.delete(session); opts.on({ type: "closed", reason }); } },
          on(e) {
            if (e.type === "error") {
              const fatal = !started || !(e.error?.client_event_id ?? e.client_event_id);
              opts.on({ type: "error", message: fatal ? say("GPT Live : erreur de session", "GPT Live: session error") : say("GPT Live a refusé une commande ; la conversation reste ouverte.", "GPT Live refused a command; the conversation stays open."), fatal });
              return fatal ? { close: "GPT Live : session refusée" } : undefined;
            }
            if (e.type === "session.output_audio.delta") {
              const pcm = decoder.push(Buffer.from(e.delta, "base64"));
              if (pcm.length) opts.on({ type: "audio", generation: 0, pcm, rate: 16000 });
            } else if (e.type === "session.input_transcript.delta") opts.on({ type: "input_transcript", text: e.delta, final: false, startMs: e.start_ms, endMs: e.end_ms });
            else if (e.type === "session.output_transcript.delta") opts.on({ type: "output_transcript", text: e.delta, final: false });
            else if (e.type === "session.delegation.created" && e.delegation?.target === "client") opts.on({ type: "delegation", id: e.delegation.id, offsetMs: e.offset_ms });
            else if (e.type === "session.closed") { closed = true; if (session) sessions.delete(session); opts.on({ type: "closed", reason: "Session terminée" }); }
          },
        });
        if (!ctx.alive || opts.signal.aborted) { await socket.close({ type: "session.close" }, "session.closed"); throw new Error("Session annulée pendant la connexion"); }
        const opened: LiveSession = {
          pushAudio: (frame) => { if (!closed) socket.send({ type: "session.input_audio.append", audio: floatToPcm16(frame).toString("base64") }); },
          append: (kind, text, delegationId) => {
            if (closed) return;
            // 500 tokens maximum par append ; découpage UTF-8 conservateur (tokens octets au pire).
            let fragment = "";
            const send = () => { if (fragment) socket.send({ type: `session.${kind === "say" ? "commentary" : kind === "think" ? "thinking" : "instructions"}.append`, event_id: randomUUID(), delegation_id: delegationId ?? null, content: fragment }); };
            for (const char of text) {
              if (Buffer.byteLength(fragment + char) > 480) { send(); fragment = ""; }
              fragment += char;
            }
            send();
          },
          close: async () => { closed = true; sessions.delete(opened); await socket.close({ type: "session.close" }, "session.closed"); },
        };
        session = opened; sessions.add(opened);
        return opened;
      },
    };
    // Le compte est un moteur Live qu'on active (slot conversation.live) : le noyau l'ouvre seulement en mode Live.
    ctx.offer("live", {
      items: () => [{ id: "account", label: "GPT Live", cloud: true }],
      start(f) {
        const a = account.availability();
        if (!a.ready) throw new TextError(a.reasonText ?? T("Fournisseur non configuré", "Provider not configured"));
        f.provide("live", service);
      },
    });
  },
});
