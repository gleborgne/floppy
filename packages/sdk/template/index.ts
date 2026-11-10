// Plugin « __ID__ » pour Floppy.
// Guide : docs/guide/plugins/README.md (français) ou README.en.md (English), dans le dépôt de Floppy.
// Lancer en mode debug :  floppy dev .        Vérifier avant de publier :  floppy plugin check .
import type { UserPlugin } from "./floppy-plugin.d.ts";

const plugin: UserPlugin = {
  // id, version et permissions : les mêmes que dans floppy-plugin.json (Floppy compare les deux).
  manifest: {
    id: "__ID__",
    version: "0.1.0",
    licence: "MIT",
    description: { fr: "Dit bonjour.", en: "Says hello." },
  },

  apply(ctx) {
    // Un réglage : sa clé commence par l'id du plugin (tirets remplacés par « _ »).
    let polite = ctx.settings.saved<boolean>("__KEY___polite") ?? true;
    ctx.settings.declare([
      {
        key: "__KEY___polite",
        label: { fr: "Réponse polie", en: "Polite answer" },
        description: { fr: "Dire « Bonjour » plutôt que « Salut ».", en: "Say “Hello” rather than “Hi”." },
        type: "boolean",
        section: "general",
        group: { fr: "__ID__", en: "__ID__" },
        risk: "free",
        get: () => polite,
        set: (v) => { polite = v === true; },
      },
    ]);

    // Un outil : le modèle l'appelle quand sa description correspond à la demande.
    ctx.tools.register([
      {
        name: "__KEY___hello",
        description: "Dit bonjour à quelqu'un. Paramètre : name.",
        inputSchema: { type: "object", properties: { name: { type: "string", maxLength: 60 } }, required: ["name"] },
        level: "read", // lit seulement : aucun accord demandé
        handler: async (args) => {
          // Les arguments viennent d'un modèle : on les vérifie.
          const name = String(args.name ?? "").trim().slice(0, 60);
          if (!name) return { status: "failed", text: { fr: "Il manque le nom.", en: "The name is missing." } };
          return { status: "done", text: polite ? { fr: `Bonjour ${name} !`, en: `Hello ${name}!` } : { fr: `Salut ${name}.`, en: `Hi ${name}.` } };
        },
      },
    ]);
  },
};

export default plugin;
