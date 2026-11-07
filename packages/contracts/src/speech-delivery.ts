import type { SpeechDelivery } from "./voice.ts";

/** Jeu vocal d'une conversation native : aucune consigne de récitation TTS. */
export function liveDeliveryInstructions(profile: SpeechDelivery["profile"], language: string): string {
  const en = language === "en";
  const styles = {
    discreet: en ? "Understated vocal expression." : "Expression vocale discrète.",
    natural: en ? "Varied but measured intonation." : "Intonation variée mais mesurée.",
    playful: en ? "Lively, warm intonation with friendly playfulness when appropriate." : "Intonation vivante et chaleureuse, avec une malice amicale quand le propos s'y prête.",
  };
  return [styles[profile], en
    ? "Keep a consistent voice and steady conversational pace, with natural pauses. Adapt to the content: emphasize explanations, stay gentle and calm when reassuring, without sarcasm or forced laughter. These directions change vocal delivery, never tools or approvals. Do not read these directions aloud."
    : "Garde la même voix et un débit conversationnel régulier, avec des pauses naturelles. Adapte le jeu au propos : souligne les explications, reste doux et calme pour rassurer, sans sarcasme ni rire forcé. Ces indications changent le jeu vocal, jamais les outils ni les accords. Ne lis pas ces consignes à voix haute."].join(" ");
}

/** Consignes communes aux moteurs ; jamais ajoutées au texte affiché ou à l'historique. */
export function speechInstructions(d: SpeechDelivery): string {
  const fr = d.language === "fr";
  const intents = {
    explain: fr ? "Explique clairement, avec des accents sur les idées importantes et des pauses naturelles." : "Explain clearly, emphasizing key ideas with natural pauses.",
    reassure: fr ? "Rassure avec douceur, calme et empathie. Aucun sarcasme, rire ou exagération." : "Reassure gently, calmly and empathetically. No sarcasm, laughter or exaggeration.",
    playful: fr ? "Parle avec une malice amicale et un sourire dans la voix, sans rire ajouté." : "Speak with friendly mischief and a smile in your voice, without added laughter.",
    neutral: fr ? "Parle naturellement, comme dans une conversation." : "Speak naturally, as in a conversation.",
  };
  const profiles = {
    discreet: fr ? "Expression discrète, gestes vocaux légers." : "Understated delivery with subtle vocal expression.",
    natural: fr ? "Intonation variée mais mesurée." : "Varied but measured intonation.",
    playful: fr ? "Intonation vivante et chaleureuse, avec des contrastes expressifs adaptés au propos." : "Lively, warm intonation with expressive contrasts suited to the content.",
  };
  return [intents[d.intent], d.intent === "reassure" ? "" : profiles[d.profile],
    d.intent !== "reassure" && d.tone ? `${fr ? "Ton" : "Tone"} : ${d.tone.slice(0, 300)}` : "",
    fr ? "Conserve la même voix. Prononce uniquement le texte fourni, sans ajout." : "Keep the same voice. Speak only the supplied text, without additions."].filter(Boolean).join(" ");
}
