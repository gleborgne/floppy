import type { SpeechDelivery } from "./voice.ts";

// Couleurs de jeu, pas des événements sonores : « laugh » ne déclenche pas un rire enregistré.
const COLORS: Record<string, [string, string]> = {
  happy: ["satisfait et souriant", "pleased and smiling"],
  joy: ["joyeux et lumineux", "joyful and bright"],
  excited: ["enthousiaste", "excited"],
  proud: ["fier et satisfait", "proud and satisfied"],
  surprised: ["surpris", "surprised"], shocked: ["étonné", "astonished"],
  relieved: ["soulagé", "relieved"],
  curious: ["curieux", "curious"],
  confused: ["perplexe et hésitant", "puzzled and hesitant"],
  skeptical: ["dubitatif", "skeptical"],
  mischief: ["malicieux et complice", "mischievous and friendly"],
  wink: ["complice", "playful"], laugh: ["amusé", "amused"],
  love: ["tendre et chaleureux", "affectionate and warm"], shy: ["timide", "shy"],
  thinking: ["réfléchi", "thoughtful"], focused: ["concentré et précis", "focused and clear"],
  determined: ["déterminé", "determined"],
  angry: ["ferme mais posé", "firm but composed"], annoyed: ["ferme mais patient", "firm but patient"],
  sad: ["doux et empathique", "gentle and empathetic"], sorry: ["doux et empathique", "gentle and empathetic"],
  cry: ["doux et empathique", "gentle and empathetic"], scared: ["calme et rassurant", "calm and reassuring"],
  sleepy: ["doux et détendu", "soft and relaxed"], tired: ["posé", "calm"], bored: ["sobre", "understated"],
};

/** Description courte pour les adaptateurs à balises ou à consignes. Aucune syntaxe fournisseur. */
export function speechStyle(d: SpeechDelivery, language: "fr" | "en" = d.language): string {
  const fr = language === "fr";
  if (d.intent === "reassure") return fr ? "doux et rassurant" : "soft tone";
  const intensity = Number.isFinite(d.intensity) ? Math.max(0, Math.min(1.5, d.intensity!)) : 1;
  if (intensity === 0) return "";
  const level = intensity * (d.profile === "discreet" ? 0.45 : d.profile === "natural" ? 0.8 : 1);
  const color = d.emotion && Object.hasOwn(COLORS, d.emotion) ? COLORS[d.emotion] : undefined;
  if (color) return `${level < 0.5 ? (fr ? "légèrement " : "slightly ") : level > 1.1 ? (fr ? "très " : "very ") : ""}${color[fr ? 0 : 1]}`;
  if (d.intent === "playful") return level < 0.5 ? (fr ? "légèrement amusé" : "slightly amused")
    : d.profile === "playful" ? (fr ? "chaleureux et joueur" : "warm and playful") : (fr ? "chaleureux et amical" : "warm and friendly");
  if (d.intent === "explain") return level < 0.5 ? (fr ? "calme" : "calm") : (fr ? "clair et vivant" : "clear and engaging");
  return level < 0.5 ? "" : d.profile === "playful" ? (fr ? "chaleureux et amical" : "warm and friendly") : (fr ? "détendu" : "relaxed");
}

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
  const style = speechStyle(d);
  return [intents[d.intent], d.intent === "reassure" || d.intensity === 0 ? "" : profiles[d.profile],
    style ? `${fr ? "Jeu vocal" : "Vocal delivery"} : ${style}.` : "",
    d.intent !== "reassure" && d.tone ? `${fr ? "Ton" : "Tone"} : ${d.tone.slice(0, 300)}` : "",
    fr ? "Fais entendre les contrastes par l'intonation et les accents sur les mots importants, avec de petites pauses aux transitions. Ne transforme pas l'intensité en volume ou en accélération. Aucun rire, sanglot ou soupir ajouté."
      : "Express contrasts through intonation and emphasis on key words, with small pauses at transitions. Do not turn intensity into loudness or acceleration. Do not add laughter, sobs or sighs.",
    fr ? "Conserve la même voix. Prononce uniquement le texte fourni, sans ajout." : "Keep the same voice. Speak only the supplied text, without additions."].filter(Boolean).join(" ");
}
