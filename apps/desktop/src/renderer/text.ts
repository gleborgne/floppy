// La saisie rejoint le corps de l'avatar : aucun historique ou assistant parallèle.
// Éléments de la page : ils existent dans text.html (pas de repli).
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Lang = "fr" | "en";
const texts: Record<Lang, Record<"label" | "hint" | "cancel" | "send" | "error", string>> = {
  fr: { label: "Écrire à Floppy", hint: "Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne · Échap pour fermer", cancel: "Annuler", send: "Envoyer", error: "Floppy n'est pas encore prêt. Réessaie dans un instant." },
  en: { label: "Write to Floppy", hint: "Enter to send · Shift+Enter for a new line · Escape to close", cancel: "Cancel", send: "Send", error: "Floppy is not ready yet. Try again in a moment." },
};
const prompt = el<HTMLTextAreaElement>("prompt");
const form = el<HTMLFormElement>("request");
const send = el<HTMLButtonElement>("send");
const error = el("error");
let lang: Lang = "fr", sending = false;
function setLang(value: string): void {
  lang = value === "en" ? "en" : "fr";
  document.documentElement.lang = lang;
  for (const id of ["label", "hint", "cancel", "send", "error"] as const) el(id).textContent = texts[lang][id];
}
window.floppyText.onLang(setLang);
window.floppyText.onFocus(() => prompt.focus());
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending || !prompt.value.trim()) return;
  sending = true; send.disabled = true; error.hidden = true;
  try {
    if (await window.floppyText.submit(prompt.value)) { window.floppyText.close(); return; }
    error.hidden = false;
  } catch { error.hidden = false; }
  finally { sending = false; send.disabled = false; }
});
el("cancel").addEventListener("click", () => window.floppyText.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.floppyText.close();
  if (e.target === prompt && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
setLang("fr");

// Module (pas de nom global partagé entre les pages).
export {};
