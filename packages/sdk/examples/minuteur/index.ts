// Exemple 1 : un outil, un réglage, un événement plus tard (« initiative »).
// « Lance un minuteur de 10 minutes » → Floppy te prévient à la fin.
import type { UserPlugin } from "../../floppy-plugin.d.ts";

const plugin: UserPlugin = {
  manifest: {
    id: "minuteur",
    version: "1.0.0",
    licence: "MIT",
    description: { fr: "Un minuteur : Floppy te prévient quand le temps est écoulé.", en: "A timer: Floppy tells you when the time is up." },
  },

  apply(ctx) {
    let importance: "important" | "normal" = ctx.settings.saved<"important" | "normal">("minuteur_annonce") ?? "important";
    let compteur = 0;

    ctx.settings.declare([
      {
        key: "minuteur_annonce",
        label: { fr: "Annonce de fin de minuteur", en: "Timer end announcement" },
        description: { fr: "Dire la fin du minuteur à voix haute, ou seulement l'afficher.", en: "Say the end of the timer aloud, or only show it." },
        type: "enum",
        section: "general",
        group: { fr: "Minuteur", en: "Timer" },
        risk: "free",
        options: [
          { value: "important", label: { fr: "À voix haute", en: "Aloud" }, aliases: ["voix", "parler", "aloud", "voice"] },
          { value: "normal", label: { fr: "Affichage seulement", en: "Display only" }, aliases: ["silence", "discret", "silent", "quiet"] },
        ],
        get: () => importance,
        set: (v) => { importance = v === "normal" ? "normal" : "important"; },
      },
    ]);

    ctx.tools.register([
      {
        name: "lancer_minuteur",
        description: "Lance un minuteur. Quand il sonne, l'assistant prévient l'utilisateur. Paramètre : minutes (de 1 à 180).",
        inputSchema: { type: "object", properties: { minutes: { type: "number", minimum: 1, maximum: 180 } }, required: ["minutes"] },
        level: "write", // il change quelque chose chez l'utilisateur (un minuteur tourne)
        handler: async (args) => {
          const minutes = Number(args.minutes);
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
            return { status: "failed", text: { fr: "La durée doit être entre 1 et 180 minutes.", en: "The duration must be between 1 and 180 minutes." } };
          }
          const numero = ++compteur;
          // ctx.timeout est arrêté tout seul si le plugin s'arrête ou se recharge.
          ctx.timeout(() => {
            ctx.emit("initiative", { source: "minuteur", text: `Ton minuteur de ${minutes} minutes est terminé.`, importance, key: `minuteur-${numero}` });
          }, minutes * 60_000);
          return { status: "done", text: { fr: `Minuteur de ${minutes} minutes lancé.`, en: `${minutes}-minute timer started.` } };
        },
      },
    ]);
  },
};

export default plugin;
