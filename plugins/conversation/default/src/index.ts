// Plugin `conversation` : orchestre les tours, pour chaque corps branché.
//
// - Corps vocal : flux voix (VAD/STT/TTS) ouvert pour lui. Mot d'activation requis, sauf pendant l'écoute libre
//   (quelques secondes après une réponse) ou en « parler en maintenant une touche ».
// - Corps texte : chaque message est un tour, sans mot d'activation.
// - Règle d'or : la réponse revient sur le corps d'origine, dans sa forme (voix ou texte).
// - État et émotion : envoyés à tous les corps qui savent les montrer.
// - « oui » / « non » à la voix répond à une demande d'accord en cours (« yes » / « no » aussi).
// - Choix dans une liste (outil ask_choice) : les options sont dites sur le corps vocal d'origine ; « 2 », « la deuxième »,
//   « the last one » ou le nom d'une option répondent, à la voix ou tapés, sur n'importe quel corps d'origine.
// - Langues : ce que Floppy dit suit la langue de l'assistant (ctx.assistant.language, le plugin redémarre quand
//   elle change) ; les erreurs montrées dans les fenêtres suivent la langue de l'interface (ctx.uiLang()).
// - Interruption : si l'utilisateur parle pendant la voix, tout s'arrête (cerveau, synthèse, lecture).
import { definePlugin, type Text, AudioHistory, T, tr, errorText } from "@floppy/core";
import type { BrainService, LiveService, TtsService, WakewordService, TurnMode, SpeechDelivery } from "@floppy/contracts";
import type { BodyState, Cue, Emotion } from "@floppy/protocol";
import { isSleepCommand, isWakeUpPhrase, stripWakeWord, yesNo, matchQuickSetting } from "./text.ts";
import { matchChoice, choicePrompt } from "./choice-match.ts";
import { isExpectedTransition, openListeningState } from "./body-state.ts";
import { isRepeatRequest } from "./repeat.ts";
import { spokenForm } from "./spoken-form.ts";

import { SpeechQueue } from "./speech.ts";
import { LiveConversation } from "./live.ts";
import { MoodTracker } from "./mood.ts";
import { guessEmotion, ReplyFeeler } from "./feel.ts";
import { Dictation } from "./dictation.ts";
import { Config, PHRASES, ECHO_TAIL_MS, type Body, type Turn } from "./model.ts";
import { createInitiatives } from "./initiatives.ts";
import { createTurns } from "./turn.ts";
import { deliveryFor, type SentencePlan } from "./plan.ts";
import { voiceHandler } from "./voice-events.ts";
import { expressivenessFactor } from "@floppy/toolkit";

export { PHRASES };

export * from "./text.ts";
export { matchChoice, choicePrompt } from "./choice-match.ts";
export { liveInstructions } from "./live.ts";
export { MoodTracker, AFFECT } from "./mood.ts";
export { guessEmotion, ReplyFeeler } from "./feel.ts";

export default definePlugin<Config>({
  manifest: {
    id: "conversation",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "voice", order: 20, label: { fr: "Voix", en: "Voice" } },
      { id: "listening", order: 30, label: { fr: "Écoute", en: "Listening" }, description: { fr: "Comment Floppy t'entend et quand il écoute.", en: "How Floppy hears you and when it listens." } },
    ],
    description: { fr: "Orchestre les tours : mot d'activation, écoute libre, voix ou texte selon le corps, interruptions, émotions.", en: "Runs conversation turns: wake word, open listening, voice or text depending on the body, interruptions, emotions." },
    inject: ["body"],
    // brain : demandé (ctx.use) seulement quand le mode en a besoin. Le noyau fait tourner le reste à la demande.
    optional: ["brain", "voice", "memory", "vocabulary", "mcp"],
    slots: [
      { id: "conversation.live", service: "live", section: "brain", label: { fr: "Mode de conversation", en: "Conversation mode" },
        none: { fr: "Local", en: "Local" }, display: "mode",
        description: { fr: "Local : un cerveau et une voix, choisis à part. Live : un seul modèle cloud qui écoute et parle (la délégation reste).", en: "Local: a brain and a voice, chosen separately. Live: one cloud model that listens and speaks (delegation stays)." } },
      { id: "voice.tts", service: "tts", section: "voice", label: { fr: "Voix", en: "Voice" }, display: "tabs",
        none: { fr: "Aucune (réponses écrites)", en: "None (written replies)" }, defaultFirst: true,
        description: { fr: "Le moteur et la voix de Floppy en mode Local. En Live, c'est le moteur Live qui parle.", en: "Floppy's engine and voice in Local mode. In Live mode, the Live engine speaks." } },
      { id: "listen.wakeword", service: "wakeword", section: "listening", label: { fr: "Mot d'activation", en: "Wake word" }, display: "tabs", step: 3,
        none: { fr: "Aucun (bouton seulement)", en: "None (button only)" },
        description: { fr: "Le plugin qui reconnaît « Floppy ». Le bouton parler marche toujours.", en: "The plugin that recognizes “Floppy”. The talk button always works." } },
    ],
    permissions: { approvals: "respond" },
  },
  config: Config,
  async apply(ctx, cfg) {
    const hub = ctx.get("body");
    const voice = ctx.maybe("voice");
    // Ce que Floppy dit : langue de l'assistant (fixe pendant la vie du plugin). Ce que l'on montre : langue de l'interface.
    const lang = ctx.assistant.language === "en" ? "en" : "fr";
    const inLang = (fr: string, en: string) => (lang === "en" ? en : fr);
    const shown = (t: Text) => tr(t, ctx.uiLang());
    const approvalPrompt = cfg.approval_prompt || tr(PHRASES.approval_prompt, lang);
    const errorReply = cfg.error_reply || tr(PHRASES.error_reply, lang);
    // Le détecteur choisi (slot) tourne dans un fork de son plugin, seulement tant que la conversation tourne.
    const wakeword = await ctx.slot<WakewordService>("listen.wakeword");
    const selectedWake = (ctx.settings.list().find((x) => x.key === "slot.listen.wakeword")?.value ?? "@none") !== "@none";
    /** Un élément est choisi pour ce slot (même s'il n'a pas pu démarrer). */
    const chosen = (slot: string) => (ctx.settings.list().find((x) => x.key === `slot.${slot}`)?.value ?? "@none") !== "@none";
    // Ce que demande le mode. Le noyau démarre ce qui est demandé et arrête le reste : en Live, ni cerveau local
    // ni voix locale ne tournent ; changer de mode redémarre cette conversation sur les bons services.
    const live = await ctx.slot<LiveService>("conversation.live");
    const liveUnavailable = !live && chosen("conversation.live");
    const separate = !live && !liveUnavailable;
    const brain: BrainService | undefined = separate || live?.capabilities.tools === "delegation" ? await ctx.use("brain") : undefined;
    const tts = separate ? await ctx.slot<TtsService>("voice.tts") : undefined;
    // « Aucune » voix choisie : Floppy répond par écrit, sans erreur. Une voix choisie mais absente : erreur montrée.
    // « Aucune » est un choix seulement s'il y avait des voix (sinon le slot prend la première) : sans voix du tout,
    // le flux voix parle lui-même (service voix complet), comme avant.
    const ttsSetting = ctx.settings.list().find((x) => x.key === "slot.voice.tts");
    const mute = separate && !tts && ttsSetting?.value === "@none" && (ttsSetting.options ?? []).some((o) => o.value !== "@none");
    const ttsUnavailable = separate && !tts && !mute;
    let tone = ctx.settings.saved<string>("tone") ?? tr(PHRASES.tone, lang);
    const savedProfile = ctx.settings.saved<string>("expressiveness");
    let profile: SpeechDelivery["profile"] = savedProfile === "discreet" || savedProfile === "natural" || savedProfile === "playful" ? savedProfile : cfg.expressiveness;
    ctx.settings.declare([{
      key: "expressiveness", section: "voice", type: "enum", risk: "free",
      label: T("Expressivité", "Expressiveness"), description: T("Intensité des expressions. Seules les voix compatibles jouent les émotions : la liste des voix l'indique.", "Expression intensity. Only compatible voices play emotions: the voice list shows which."),
      options: [{ value: "discreet", label: T("Discret", "Discreet"), aliases: ["discret", "discrete", "discreet"] },
        { value: "natural", label: T("Naturel", "Natural"), aliases: ["naturel", "naturelle", "natural"] },
        { value: "playful", label: T("Joueur", "Playful"), aliases: ["joueur", "joueuse", "playful"] }],
      get: () => profile, set: v => { profile = v as SpeechDelivery["profile"]; for (const b of bodies.values()) b.live?.updateTone(); },
    }]);
    // Expérimental (non essayé sur un vrai compte) : s'applique à la prochaine session Live, pas à celle qui est ouverte.
    let liveEmotionTool = ctx.settings.saved<boolean>("emotion_live") ?? cfg.live_emotion_tool;
    ctx.settings.declare([{
      key: "emotion_live", section: "voice", type: "boolean", risk: "free",
      label: T("Émotion annoncée par le modèle Live (expérimental)", "Emotion reported by the Live model (experimental)"),
      description: T("En mode Live, le modèle dit son émotion par un outil silencieux pour le visage et les gestes, au lieu de la deviner dans ses mots. Seulement pour un moteur Live qui appelle des outils. S'applique à la prochaine session Live.",
        "In Live mode, the model reports its emotion through a silent tool for the face and gestures, instead of guessing it from its words. Only for a Live engine that calls tools. Applies from the next Live session."),
      get: () => liveEmotionTool, set: (v) => { liveEmotionTool = Boolean(v); },
    }]);
    ctx.settings.declare([{ key: "tone", section: "voice", label: { fr: "Ton", en: "Tone" }, description: { fr: "La manière de parler, commune à tous les modes.", en: "Speaking style shared by all conversation modes." }, type: "text", maxLength: 300, risk: "free", get: () => tone, set: (v) => { tone = String(v); for (const b of bodies.values()) b.live?.updateTone(); } }]);
    const wake = wakeword?.words?.() ?? [...ctx.assistant.wake_words];
    let freeListen = ctx.settings.saved<number>("free_listen_s") ?? cfg.free_listen_s;
    ctx.settings.declare([{
      key: "free_listen_s", section: "listening", type: "number", min: 0, max: 30, risk: "free",
      label: { fr: "Écoute libre", en: "Open listening" }, group: { fr: "Écoute", en: "Listening" },
      description: { fr: "Secondes pendant lesquelles on peut enchaîner sans redire le mot d'activation, après une réponse (« Je t'écoute… » reste affiché). 0 : il faut toujours redire son nom.", en: "Seconds during which you can carry on without repeating the wake word after a reply (\"Listening…\" stays on screen). 0: always say the wake word." },
      get: () => freeListen, set: (v) => { freeListen = Number(v); },
    }]);
    const bodies = new Map<string, Body>();
    let turnSeq = 0;
    let neutralTimer: NodeJS.Timeout | undefined;
    ctx.effect(() => clearTimeout(neutralTimer));

    // ------------------------------------------------------------ état et émotion (tous les corps)
    const setState = (b: Body, state: BodyState) => {
      // Filet de diagnostic : une transition hors de la table est journalisée, jamais refusée.
      if (!isExpectedTransition(b.state, state)) {
        ctx.log("debug", `transition d'état inattendue sur ${b.id} : ${b.state} → ${state}`);
        ctx.audit.write({ kind: "state.unexpected", body: b.id, from: b.state, to: state });
      }
      b.state = state;
      hub.broadcast({ type: "state", state }, "emotion");
      if (!hub.has(b.id, "emotion")) hub.send(b.id, { type: "state", state });
    };
    // Humeur : fond émotionnel qui change lentement ; les corps la montrent quand aucune émotion n'est en cours.
    const mood = new MoodTracker();
    const sendMood = () => {
      const m = mood.changed();
      if (m) hub.broadcast({ type: "mood", ...m }, "emotion");
    };
    ctx.interval(() => { mood.tick(); sendMood(); }, 20_000);
    const setEmotion = (emotion: Emotion | string, ms?: number, intensity?: number, timing?: { body: string; id: string }, opts: { mood?: boolean } = {}) => {
      clearTimeout(neutralTimer);
      for (const body of hub.sessions()) {
        if (!body.capabilities.includes("emotion")) continue;
        hub.send(body.id, { type: "emotion", emotion: emotion as Emotion, ...(ms ? { ms } : {}), ...(intensity === undefined && profile === "playful" ? {} : { intensity: (intensity ?? 1) * expressivenessFactor(profile) }),
          ...(timing?.body === body.id && body.capabilities.includes("speech_timing") ? { nextAudio: timing.id } : {}) });
      }
      // Un simple apaisement de l'émotion d'une étiquette ne pousse pas l'humeur une fois de plus.
      if (opts.mood !== false) mood.feel(emotion as Emotion, intensity ?? 1);
      sendMood();
    };
    const cue = (c: Cue) => hub.broadcast({ type: "cue", cue: c }, "emotion");
    const neutralSoon = () => {
      clearTimeout(neutralTimer);
      neutralTimer = setTimeout(() => hub.broadcast({ type: "emotion", emotion: "neutral" }, "emotion"), cfg.neutral_after_ms);
    };

    // ------------------------------------------------------------ fin de tour
    /** Garde le texte de la réponse (terminée ou coupée) pour « répète ». */
    const rememberReply = (b: Body, t: Turn) => { const text = t.reply.trim(); if (text) b.lastReply = text; };
    const finish = (b: Body, t: Turn) => {
      if (b.turn !== t) return;
      b.turn = undefined;
      b.lastTurnAt = Date.now();
      rememberReply(b, t);
      b.stream?.setSpeaking(false);
      if (t.mode === "voice") listenFreely(b);
      else setState(b, b.muted ? "sleep" : "idle");
      neutralSoon();
      ctx.audit.write({ kind: "turn", body: b.id, mode: t.mode, ms: t.marks });
      drain();
    };
    const maybeFinish = (b: Body, t: Turn) => {
      if (!t.abort.signal.aborted && t.brainDone && t.pending.size === 0 && !b.playing) finish(b, t);
    };

    /** Garde la phrase en mémoire pour reconnaître son écho dans le micro. */
    const remember = (b: Body, text: string) => {
      const now = Date.now();
      b.spoken = [...(b.spoken ?? []).filter((x) => now - x.at < 120_000), { text, at: now }].slice(-30);
    };
    /** Envoie à la voix une phrase sans plan (erreur, accord, initiative) : même livraison que celle d'un plan, sans silence ni geste. */
    const speakOut = (b: Body, id: string, text: string, emotion?: string, intensity?: number) => {
      remember(b, text);
      b.output!.speak(id, spokenForm(text, lang), deliveryFor({ emotion, intensity, profile, language: lang, tone }));
    };
    /** Envoie à la voix une phrase du tour, avec la livraison de son plan. */
    const speakPlanned = (b: Body, id: string, plan: SentencePlan) => {
      remember(b, plan.text);
      b.output!.speak(id, plan.text, plan.delivery);
    };
    /** Floppy parle ou vient de parler : un texte entendu peut être l'écho de sa voix. */
    const mayEcho = (b: Body) => b.playing || !!b.duck || Date.now() - (b.playEndAt ?? 0) < ECHO_TAIL_MS;
    /** Fin de l'attente « qui parle ? ». `restore` : on remonte la voix (c'était un écho ou rien). */
    const endDuck = (b: Body, restore: boolean) => {
      if (!b.duck) return;
      clearTimeout(b.duck.timer);
      b.duck = undefined;
      if (restore) {
        hub.send(b.id, { type: "duck", on: false });
        if (b.playing) b.stream?.setSpeaking(true); // réarme la coupure de parole pour la suite de la réponse
      }
    };
    const duckFor = (b: Body, ms: number) => {
      if (!b.duck) return;
      clearTimeout(b.duck.timer);
      b.duck.timer = setTimeout(() => {
        if (!ctx.alive || !b.duck) return;
        endDuck(b, true);
        ctx.audit.write({ kind: "barge_in.resumed", body: b.id, why: "aucun texte reconnu" });
      }, ms);
    };
    ctx.effect(() => { for (const b of bodies.values()) if (b.duck) clearTimeout(b.duck.timer); });

    /** Écoute libre relancée : « j'écoute » pendant `freeListen` s, puis retour au repos si rien n'arrive. */
    function listenFreely(b: Body) {
      b.awakeUntil = Date.now() + freeListen * 1000;
      setState(b, openListeningState(b));
      ctx.timeout(() => { if (!b.turn && !b.init && b.state === "listening" && Date.now() >= b.awakeUntil) setState(b, "idle"); }, freeListen * 1000 + 50);
    }

    /** L'utilisateur coupe la parole à Floppy : on se tait et ce qu'il dit ensuite s'adresse à Floppy. */
    function userBargeIn(b: Body) {
      endDuck(b, false);
      if (b.init) { abortInit(b); listenFreely(b); return; }
      if (!b.turn) { listenFreely(b); return; }
      interrupt(b, "l'utilisateur parle");
      // Sans écoute libre relancée, une coupure après sa fin jetait la phrase en silence.
      listenFreely(b);
      setEmotion("neutral");
    }

    const interrupt = (b: Body, why: string) => {
      const t = b.turn;
      if (!t) return;
      rememberReply(b, t);
      endDuck(b, false);
      t.abort.abort();
      b.output?.cancel();
      hub.send(b.id, { type: "interrupt" });
      b.turn = undefined;
      b.playing = false;
      b.stream?.setSpeaking(false);
      ctx.log("info", `tour ${t.n} interrompu (${why})`);
      ctx.audit.write({ kind: "turn.interrupted", body: b.id, why, n: t.n, spoke: t.spoke, brain_done: t.brainDone, pending: t.pending.size, ms: t.marks });
    };

    // ------------------------------------------------------------ initiatives (annonces venant d'autres plugins)
    const { sayDirect, finishInit, abortInit, drain, recent } = createInitiatives({
      ctx, hub, live, bodies, nextSeq: () => ++turnSeq,
      setState, setEmotion, neutralSoon, speakOut, endDuck, listenFreely,
    });

    // ------------------------------------------------------------ un tour (voir turn.ts)
    const { runTurn } = createTurns({
      ctx, hub, cfg, brain, lang, inLang, errorReply, wake, recent: () => recent, nextSeq: () => ++turnSeq,
      tone: () => tone, profile: () => profile,
      setState, setEmotion, speakOut, speakPlanned, finish, maybeFinish, interrupt, abortInit,
    });

    // ------------------------------------------------------------ entrée : un texte entendu ou tapé
    // `accepted` : appelé quand l'énoncé est retenu (pas ignoré, pas dit en veille) ; sert à l'audit.
    const approvalsFor = (b: Body) => {
      const capable = hub.sessions().filter((s) => s.enabled !== false && s.capabilities.includes("approval"));
      return ctx.approvals.pending().filter((p) => p.origin === b.id || (!p.origin && capable.length === 1 && capable[0]!.id === b.id));
    };
    const answerApproval = (b: Body, text: string): boolean => {
      if (b.muted || !hub.has(b.id, "approval")) return false;
      const pending = approvalsFor(b);
      const answer = pending.length ? yesNo(text, wake) : undefined;
      if (answer === undefined) return false;
      b.live?.noteApprovalReply(stripWakeWord(text, wake));
      ctx.approvals.respond(pending.at(-1)!.id, answer, `${b.id}:voice`);
      setEmotion(answer ? "happy" : "neutral");
      return true;
    };
    // Choix dans une liste : même règle d'origine que les accords, mais aucune capacité requise du corps
    // (un corps voix seule ou texte seul répond). Un accord en attente garde la priorité.
    const choicesFor = (b: Body) => {
      const capable = hub.sessions().filter((s) => s.enabled !== false && s.capabilities.includes("choice"));
      return ctx.choices.pending().filter((p) => p.origin === b.id || (!p.origin && capable.length === 1 && capable[0]!.id === b.id));
    };
    const answerChoice = (b: Body, text: string): boolean => {
      if (b.muted || approvalsFor(b).length) return false;
      const pending = choicesFor(b).at(-1);
      const picked = pending ? matchChoice(text, wake, pending.options) : undefined;
      if (!pending || picked === undefined) return false;
      if (!ctx.choices.respond(pending.id, picked, `${b.id}:voice`)) return false;
      setEmotion("happy");
      return true;
    };
    /** Une réponse courte à ce qui est en attente : accord (oui / non) d'abord, puis choix dans une liste. */
    const answerPending = (b: Body, text: string): boolean => answerApproval(b, text) || answerChoice(b, text);
    const onUtterance = (b: Body, raw: string, kind: "voice" | "text" | "ptt", tEnd: number, onAccepted: () => void = () => {}) => {
      let done = false;
      const accepted = () => { if (!done) { done = true; mood.touch(); onAccepted(); } };
      const text = raw.trim();
      if (!text) return;
      if (kind === "text" && (approvalsFor(b).length || choicesFor(b).length)) b.muted = false;
      if (answerPending(b, text)) { accepted(); return; }
      const woke = kind !== "voice";
      // 2. En veille : seul le mot d'activation réveille.
      if (b.muted) {
        if (kind === "voice") return;
        accepted();
        b.muted = false;
        setEmotion("happy", 1500);
        const rest = stripWakeWord(text, wake);
        if (!rest || isWakeUpPhrase(rest)) {
          setState(b, "listening");
          b.awakeUntil = Date.now() + freeListen * 1000;
          drain();
          return;
        }
      } else if (kind === "voice" && !woke && Date.now() > b.awakeUntil) {
        ctx.log("debug", "ignoré (pas de mot d'activation)");
        return;
      }
      accepted();
      // 3. « Floppy, dors »
      if (isSleepCommand(text, wake)) {
        if (b.turn) interrupt(b, "sleep");
        void b.live?.stop("sleep");
        abortInit(b);
        b.muted = true;
        b.awakeUntil = 0;
        setState(b, "sleep");
        setEmotion("sleepy");
        return;
      }
      if (kind === "text" && b.voice && b.live) {
        if (b.turn) interrupt(b, "nouvelle demande");
        abortInit(b);
        void b.live.requestText(text).catch(e => hub.send(b.id, { type: "error", text: shown(errorText(e)) }));
        return;
      }
      const mode: TurnMode = b.voice && b.stream ? "voice" : "text";
      // « Répète » : la dernière réponse est redite sans appeler le cerveau (sans réponse à redire, la phrase passe au cerveau).
      if (b.lastReply && isRepeatRequest(text, wake)) { repeatReply(b, text, mode, b.lastReply); return; }
      // 4. Voie rapide des réglages (« passe sur Gemma ») : sans LLM, pour ne jamais rester bloqué sur un modèle faible.
      const quick = matchQuickSetting(text, wake, ctx.settings.list(), lang);
      if (quick) { void quickSetting(b, quick, mode, text); return; }
      void runTurn(b, text, mode, tEnd);
    };

    const repeatReply = (b: Body, said: string, mode: TurnMode, last: string) => {
      if (b.turn) interrupt(b, "répétition");
      const reply = b.lastReply ?? last; // une réponse coupée à l'instant devient la dernière
      hub.send(b.id, { type: "transcript", text: said, final: true });
      ctx.audit.write({ kind: "reply.repeated", body: b.id, mode, chars: reply.length });
      hub.send(b.id, { type: "reply.done", text: reply });
      if (mode === "voice" && b.stream) sayDirect(b, reply);
      b.lastTurnAt = Date.now();
    };
    const quickSetting = async (b: Body, q: { key: string; value: string; label: string; slow: boolean }, mode: TurnMode, said: string) => {
      if (b.turn) interrupt(b, "réglage");
      hub.send(b.id, { type: "transcript", text: said, final: true });
      setState(b, "thinking");
      setEmotion("focused");
      const slow = q.slow;
      const voiceOut = mode === "voice" && !!b.stream;
      if (slow && voiceOut) sayDirect(b, inLang(`Je passe sur ${q.label}, ça prend quelques secondes.`, `Switching to ${q.label}, this takes a few seconds.`));
      b.quick = voiceOut;
      let r: Awaited<ReturnType<typeof ctx.settings.change>>;
      try { r = await ctx.settings.change(q.key, q.value, b.id); } finally { b.quick = false; }
      if (!ctx.alive) return;
      // r.text est déjà dans la langue de l'assistant (changement demandé à la voix).
      const reply = r.ok ? (/déjà|already/.test(r.text) ? r.text : inLang(`C'est fait : ${q.label}.`, `Done: ${q.label}.`)) : r.text;
      ctx.audit.write({ kind: "setting.quick", key: q.key, value: q.value, ok: r.ok });
      hub.send(b.id, { type: "reply.done", text: reply });
      setEmotion(r.ok ? "happy" : "sorry", 3000);
      if (voiceOut) sayDirect(b, reply);
      else setState(b, "idle");
      b.lastTurnAt = Date.now();
    };

    // ------------------------------------------------------------ accords : phrase dite sur le corps vocal d'origine
    ctx.on("approval.request", (r) => {
      setEmotion("curious");
      const b = r.origin ? bodies.get(r.origin) : undefined;
      b?.awaiting.add(r.id);
      if (b?.live?.active) { b.live.beginApproval(); return; }
      if (b?.stream && b.turn?.mode === "voice") {
        const id = `a-${r.id.slice(0, 8)}`;
        b.turn.pending.add(id);
        speakOut(b, id, approvalPrompt);
      } else if (b?.stream && b.quick) {
        // Réglage en voie rapide : pas de tour, donc on le dit directement.
        sayDirect(b, approvalPrompt);
      }
    });

    ctx.on("approval.closed", (c) => { for (const b of bodies.values()) { b.awaiting.delete(c.id); b.live?.touch(); } });

    // ------------------------------------------------------------ choix dans une liste : question et options dites sur le corps vocal d'origine
    // Limite : en Live (session ouverte), le modèle parle seul et ne peut pas lire les options : elles s'affichent
    // sur le corps (carte ou liste) et « 2 » ou le nom d'une option répondent quand même.
    ctx.on("choice.request", (r) => {
      const b = r.origin ? bodies.get(r.origin) : undefined;
      b?.awaiting.add(r.id);
      if (!b || b.live?.active) return;
      const prompt = choicePrompt(r.title, r.options, lang);
      if (b.stream && b.turn?.mode === "voice") {
        const id = `c-${r.id.slice(0, 8)}`;
        b.turn.pending.add(id);
        speakOut(b, id, prompt);
      } else if (b.stream && b.quick) sayDirect(b, prompt);
    });
    ctx.on("choice.closed", (c) => { for (const b of bodies.values()) b.awaiting.delete(c.id); });

    // Outil du modèle : l'utilisateur choisit entre quelques options concrètes. `options` est une liste de textes
    // (le schéma qu'un modèle remplit le plus sûrement) : pas de détail, les ids sont fabriqués ici.
    const MIN_OPTIONS = 2, MAX_OPTIONS = 9, CHOICE_TTL_S = 90;
    ctx.tools.register([{
      name: "ask_choice",
      description: "Demande à l'utilisateur de choisir UNE option parmi quelques options concrètes (2 à 9), affichées sur son écran et dites à voix haute. "
        + "À utiliser quand il doit trancher entre des possibilités précises (quel fichier, quel contact, quelle heure) et que tu ne peux pas décider à sa place. "
        + "Sa réponse revient comme résultat de l'outil : le libellé choisi. Attends ce résultat. Ne relis pas les options toi-même à voix haute, ne les répète pas dans ta réponse, "
        + "et ne repose pas la question si le résultat dit qu'aucun choix n'a été fait.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "La question posée, courte (ex. « Quel fichier ouvrir ? »)." },
          options: { type: "array", items: { type: "string" }, minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: "Les options, des textes courts et distincts, dans l'ordre à présenter." },
        },
        required: ["question", "options"],
      },
      level: "read",
      handler: async (a, meta) => {
        const labels = (Array.isArray(a.options) ? a.options : []).map((o) => String(o ?? "").trim()).filter(Boolean);
        const title = String(a.question ?? "").trim();
        if (!title || labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS) {
          return { status: "failed", text: T(`Il faut une question et entre ${MIN_OPTIONS} et ${MAX_OPTIONS} options (reçu : ${labels.length}).`, `A question and ${MIN_OPTIONS} to ${MAX_OPTIONS} options are needed (got: ${labels.length}).`) };
        }
        const options = labels.map((label, i) => ({ id: `o${i + 1}`, label }));
        const r = await ctx.choices.ask({ title, options, ttl_s: CHOICE_TTL_S, ...(meta.origin ? { origin: meta.origin } : {}), ...(meta.signal ? { signal: meta.signal } : {}) });
        const picked = options.find((o) => o.id === r.picked);
        if (r.reason === "user" && picked) return { status: "done", text: T(`L'utilisateur a choisi : ${picked.label}`, `The user chose: ${picked.label}`) };
        if (r.reason === "timeout") return { status: "failed", text: T("Aucun choix fait (l'utilisateur n'a pas répondu à temps). Ne repose pas la question : dis-le simplement, ou laisse tomber.", "No choice made (the user did not answer in time). Do not ask again: just say so, or drop it.") };
        return { status: "failed", text: T("Choix annulé. Ne repose pas la question.", "Choice cancelled. Do not ask again.") };
      },
    }]);

    // ------------------------------------------------------------ corps
    const onVoice = voiceHandler({
      ctx, hub, lang, shown, live, liveUnavailable, wake, freeListen: () => freeListen, bodies,
      setState, setEmotion, cue, maybeFinish, mayEcho, endDuck, duckFor, userBargeIn, interrupt, finishInit, runTurn, answerPending, onUtterance, quickSetting,
    });
    const attachWakeword = async (b: Body) => {
      b.wakeAbort?.abort(); b.wakeStream?.close(); b.wakeStream = undefined; b.wakeActivation = undefined;
      if (!wakeword) {
        if (selectedWake) hub.send(b.id, { type: "error", text: shown(T("Le plugin wakeword choisi est indisponible. Configure-le ou choisis un autre plugin dans Écoute.", "The chosen wake word plugin is unavailable. Set it up or choose another plugin in Listening.")) });
        return;
      }
      const abort = new AbortController(); b.wakeAbort = abort;
      try {
        const detector = await wakeword.open({ body: b.id, signal: abort.signal,
          onError: (text) => { if (ctx.alive && !abort.signal.aborted) hub.send(b.id, { type: "error", text }); },
          onDetection: (event) => {
            if (!ctx.alive || abort.signal.aborted || b.playing || b.ptt || b.dictation?.active || b.live?.active || bodies.get(b.id) !== b) return;
            const history = b.history;
            const start = event.startSample === undefined ? undefined : Math.max(event.startSample, history?.begin ?? 0);
            if (wakeword.input !== "transcript" && (!history || start === undefined || event.endSample === undefined || !history.slice(start, event.endSample))) return;
            b.muted = false;
            b.wakeActivation = { ...event, startSample: start, expires: Date.now() + 10_000 };
            ctx.audit.write({ kind: "wakeword.detected", body: b.id, provider: wakeword.name, word: event.word });
            cue("wake"); // « oui ? » : réaction visible tout de suite, quel que soit le détecteur
            if (wakeword.input === "transcript") return; // le transcript courant sera routé, y compris les commandes locales
            if (liveUnavailable) { hub.send(b.id, { type: "error", text: shown(T("Le moteur Live choisi est indisponible.", "The chosen Live engine is unavailable.")) }); return; }
            if (b.live) {
              if ([...bodies.values()].some(other => other !== b && other.live?.active)) return;
              b.wakeActivation = undefined; // cette détection est consommée par l'ouverture audio immédiate
              void b.live.start(start, event.endSample).catch(e => { if (ctx.alive && !abort.signal.aborted) hub.send(b.id, { type: "error", text: shown(errorText(e)) }); });
            } else setState(b, "listening");
          },
        });
        if (!ctx.alive || abort.signal.aborted || bodies.get(b.id) !== b) detector.close();
        else b.wakeStream = detector;
      } catch (e) { if (ctx.alive && !abort.signal.aborted) hub.send(b.id, { type: "error", text: shown(errorText(e)) }); }
    };
    const attachVoice = async (b: Body) => {
      const stream = await voice?.open(b.id);
      if (!ctx.alive || !bodies.has(b.id)) { stream?.close(); return; }
      if (stream) {
        b.voiceOffset = b.history?.end ?? 0;
        b.stream = stream;
        stream.setMergeEnabled?.(!live);
        b.output = new SpeechQueue({ stream, tts, mute, emit: (e) => onVoice(b, e), unavailable: ttsUnavailable ? T("La voix choisie est indisponible. Active une autre voix dans les réglages.", "The chosen voice is unavailable. Turn on another voice in the settings.") : undefined, lang: () => ctx.uiLang() });
        b.off = stream.on((ev) => onVoice(b, ev));
      } else if (!live) ctx.log("warn", `${b.id} a un micro mais aucun service voix n'est actif`);
      if (!ctx.alive) return;
      if (live) b.live = new LiveConversation({
        ctx, service: live, brain, body: b.id, history: b.history!,
        tone: () => tone, profile: () => profile, freeListen: () => freeListen,
        onInput: (text) => {
          if (isSleepCommand(text, wake)) { b.muted = true; b.history?.clear(); b.live?.stop("sleep"); setState(b, "sleep"); return; }
          answerPending(b, text);
        },
        onState: (state) => { setState(b, b.muted ? "sleep" : state); b.stream?.setSpeaking(!b.muted && state === "speaking"); if (!b.muted && state === "listening") b.awakeUntil = Date.now() + freeListen * 1000; },
        onPlaying: (on) => { b.playing = on; if (!on) { b.feeler?.reset(); neutralSoon(); } },
        onIdle: drain,
        emotionTool: () => liveEmotionTool,
        // Le modèle Live a dit son émotion par l'outil : même chemin que la devinette (setEmotion, calé sur l'audio).
        onModelEmotion: (e, timing) => setEmotion(e.emotion, undefined, e.intensity, timing),
        // Le modèle Live ne donne pas d'émotion : on la devine dans les mots (les vôtres, puis les siens).
        onHeard: (text) => {
          mood.touch();
          const g = guessEmotion(stripWakeWord(text, wake), "user");
          if (g) setEmotion(g.emotion, 1500, g.intensity);
        },
        onReply: (delta, timing) => {
          const g = (b.feeler ??= new ReplyFeeler()).push(delta);
          if (g) setEmotion(g.emotion, undefined, g.intensity, timing);
          return g?.emotion;
        },
      });
      // Une annonce a pu arriver avant que le flux vocal soit prêt.
      if (ctx.alive && bodies.get(b.id) === b) drain();
      await attachWakeword(b);
    };
    if (wakeword) ctx.effect(wakeword.onChange(() => { wake.splice(0, wake.length, ...(wakeword.words?.() ?? ctx.assistant.wake_words)); for (const b of bodies.values()) if (b.voice) void attachWakeword(b); }));

    /** Corps prêt à écouter : il quitte le « zzz » du démarrage (ou de l'arrêt précédent de la conversation). */
    const wakeUp = (b: Body, capabilities: readonly string[]) => {
      hub.send(b.id, { type: "state", state: "idle" });
      hub.send(b.id, { type: "emotion", emotion: "neutral" });
      if (capabilities.includes("emotion")) hub.send(b.id, { type: "mood", ...mood.snapshot() });
    };
    /** Un corps qui rejoint (événement `join`, ou déjà branché au démarrage) : son état, son réveil, son flux voix. */
    const createBody = (id: string, capabilities: readonly string[]) => {
      const b: Body = {
        id, voice: capabilities.includes("voice"), text: capabilities.includes("text"),
        muted: false, awakeUntil: 0, lastTurnAt: 0, playing: false, state: "idle", awaiting: new Set(), history: new AudioHistory(),
      };
      bodies.set(b.id, b);
      wakeUp(b, capabilities);
      if (b.voice) attachVoice(b).catch((e) => { ctx.log("error", `voix de ${b.id} : ${String(e)}`); hub.send(b.id, { type: "error", text: shown(T("L'écoute locale n'est pas prête. Vérifie le service voix.", "Local listening is not ready. Check the voice service.")) }); });
      return b;
    };
    const offHub = hub.on((ev) => {
      if (ev.type === "join") {
        createBody(ev.body.id, ev.body.capabilities);
      } else if (ev.type === "leave") {
        const b = bodies.get(ev.bodyId);
        if (!b) return;
        if (b.turn) interrupt(b, "corps débranché");
        void b.live?.stop("corps débranché");
        b.wakeAbort?.abort(); b.wakeStream?.close();
        b.output?.cancel();
        b.off?.();
        b.stream?.close();
        bodies.delete(ev.bodyId);
      } else if (ev.type === "audio") {
        const b = bodies.get(ev.bodyId);
        if (b) {
          const startSample = b.history?.end ?? 0;
          b.history?.push(ev.frame);
          b.stream?.pushAudio(ev.frame);
          if (b.dictation?.active) return; // dictée : l'audio ne sert qu'à elle (ni Live, ni mot d'activation)
          if (!b.muted) b.live?.pushAudio(ev.frame);
          b.wakeStream?.pushAudio(ev.frame, startSample);
          if (b.ptt && b.live && !b.live.active && !b.stream) void b.live.start(startSample, startSample + ev.frame.length).catch(e => hub.send(b.id, { type: "error", text: shown(errorText(e)) }));
        }
      } else if (ev.type === "message") {
        const b = bodies.get(ev.bodyId);
        if (!b) return;
        const m = ev.msg;
        if (m.type === "text") onUtterance(b, m.text, "text", performance.now());
        else if (m.type === "dictate") {
          if (!b.stream?.dictate) { if (m.on) hub.send(b.id, { type: "error", text: shown(T("La dictée demande l'écoute locale (service voix).", "Dictation needs local listening (voice service).")) }); return; }
          if (m.on) {
            if (b.turn) interrupt(b, "dictée");
            abortInit(b);
            if (b.ptt) { b.ptt = false; b.stream.ptt(false); }
            b.dictation = new Dictation(); // une nouvelle dictée : les segments en retard de l'ancienne sont ignorés
            b.stream.dictate(true);
            ctx.audit.write({ kind: "dictation.start", body: b.id });
          } else if (b.dictation?.active) {
            b.dictation.active = false; // les versions finales en cours arrivent encore et sont tapées
            b.stream.dictate(false);
            ctx.audit.write({ kind: "dictation.stop", body: b.id });
          }
        } else if (m.type === "ptt") {
          if (m.on && b.dictation?.active) { b.dictation.active = false; b.stream?.dictate?.(false); }
          b.ptt = m.on;
          b.stream?.ptt(m.on);
          if (m.on) { if (b.turn) interrupt(b, "parler"); b.muted = false; b.awakeUntil = Date.now() + 60_000; setState(b, "listening"); cue("perk"); mood.touch(); }
          else b.awakeUntil = Date.now() + freeListen * 1000;
        } else if (m.type === "listen.stop") {
          // La croix ferme seulement la fenêtre d'écoute ; une commande « dors » reste distincte.
          // Un clic arrivé après le début d'une réponse ne doit pas couper cette réponse.
          if (b.state !== "listening" || b.turn || b.init || b.playing) return;
          b.awakeUntil = 0;
          b.speechOpen = false;
          b.speechAt = undefined;
          b.wakeActivation = undefined;
          b.history?.clear();
          b.ptt = false;
          b.stream?.ptt(false);
          void b.live?.stop("fin de l'écoute active");
          setState(b, "idle");
          neutralSoon();
          drain();
        } else if (m.type === "mute") {
          b.muted = m.on;
          if (m.on && b.turn) interrupt(b, "muet");
          setState(b, m.on ? "sleep" : "idle");
          setEmotion(m.on ? "sleepy" : "happy", 1500);
          if (m.on) { b.awakeUntil = 0; b.speechOpen = false; b.wakeActivation = undefined; abortInit(b); b.live?.stop("muet"); b.history?.clear(); } else drain();
        } else if (m.type === "playback") {
          b.playing = m.playing;
          if (!m.playing) b.playEndAt = Date.now();
          b.live?.playback(m.playing);
          if (!m.playing && b.init?.done) finishInit(b);
          if (!m.playing && b.turn) {
            if (b.turn.pending.size === 0) b.stream?.setSpeaking(false); // plus rien ne joue : désarme l'interruption
            maybeFinish(b, b.turn);
          }
        }
      }
    });
    ctx.effect(offHub);
    // La conversation s'arrête (changement de cerveau, de voix, relance) : Floppy n'écoute plus, il « dort »
    // jusqu'à ce qu'elle reparte (elle renvoie alors « idle » à chaque corps).
    ctx.effect(() => { try { hub.broadcast({ type: "state", state: "sleep" }); } catch { /* hub arrêté */ } });
    // Corps déjà branchés avant ce plugin : au démarrage, la fenêtre se branche avant que les modèles soient
    // chargés ; ou la conversation redémarre. Sans « idle », Floppy resterait en « zzz ».
    for (const s of hub.sessions()) createBody(s.id, s.capabilities);
    ctx.effect(async () => { for (const b of bodies.values()) { b.wakeAbort?.abort(); b.wakeStream?.close(); b.turn?.abort.abort(); b.output?.cancel(); b.off?.(); b.stream?.close(); } await Promise.all([...bodies.values()].map((b) => b.live?.stop("déchargement"))); });
  },
});
