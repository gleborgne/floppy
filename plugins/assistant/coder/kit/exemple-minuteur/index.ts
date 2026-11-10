// Exemple de plugin : un minuteur. « Lance un minuteur de 10 minutes » → l'assistant te prévient à la fin.
// Un seul import, et seulement pour les types.
import type { UserPlugin } from "../floppy-plugin.d.ts";

const plugin: UserPlugin = {
  manifest: {
    id: "exemple-minuteur",
    version: "0.1.0",
    licence: "MIT",
    description: "Un minuteur : l'assistant te prévient quand le temps est écoulé.",
  },

  apply(ctx) {
    // Réglage : l'importance du message de fin (important = dit à voix haute).
    let importance: "important" | "normal" = ctx.settings.saved<"important" | "normal">("minuteur_importance") ?? "important";
    let compteur = 0;

    ctx.settings.declare([
      {
        key: "minuteur_importance",
        label: "Annonce de fin de minuteur",
        description: "Dire la fin du minuteur à voix haute, ou seulement l'afficher.",
        type: "enum",
        section: "general",
        group: "Minuteur",
        risk: "free",
        options: [
          { value: "important", label: "À voix haute", aliases: ["voix", "parler"] },
          { value: "normal", label: "Affichage seulement", aliases: ["silence", "discret"] },
        ],
        get: () => importance,
        set: (v) => { importance = v === "normal" ? "normal" : "important"; },
      },
    ]);

    ctx.tools.register([
      {
        name: "start_timer",
        description: "Lance un minuteur. Quand il sonne, l'assistant prévient l'utilisateur. Paramètre : minutes (de 1 à 180).",
        inputSchema: {
          type: "object",
          properties: { minutes: { type: "number", minimum: 1, maximum: 180 } },
          required: ["minutes"],
        },
        level: "write",
        summary: (args) => `Lancer un minuteur de ${String(args.minutes)} minutes`,
        handler: async (args) => {
          const minutes = Number(args.minutes);
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
            return { status: "failed", text: "La durée doit être entre 1 et 180 minutes." };
          }
          const numero = ++compteur;
          // ctx.timeout est arrêté tout seul si le plugin s'arrête.
          ctx.timeout(() => {
            if (!ctx.alive) return;
            ctx.emit("initiative", {
              source: "exemple-minuteur",
              text: `Ton minuteur de ${minutes} minutes est terminé.`,
              importance,
              key: `minuteur-${numero}`,
            });
          }, minutes * 60_000);
          return { status: "done", text: `Minuteur de ${minutes} minutes lancé.` };
        },
      },
    ]);
  },
};

export default plugin;
