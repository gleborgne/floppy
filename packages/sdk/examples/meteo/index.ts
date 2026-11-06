// Exemple 2 : un accès réseau déclaré. fetch ne joint que les hôtes de permissions.net
// (les mêmes ici et dans floppy-plugin.json) ; Floppy vérifie chaque requête, redirections comprises.
import type { UserPlugin } from "../../floppy-plugin.d.ts";
import { codeMeteo } from "./codes.ts";

const plugin: UserPlugin = {
  manifest: {
    id: "meteo",
    version: "1.0.0",
    licence: "MIT",
    description: { fr: "La météo du moment pour une ville (service Open-Meteo, sans clé).", en: "The current weather for a city (Open-Meteo service, no key)." },
    // cloud : le nom de la ville part sur Internet.
    permissions: { net: ["geocoding-api.open-meteo.com", "api.open-meteo.com"], cloud: true },
  },

  apply(ctx) {
    ctx.tools.register([
      {
        name: "meteo_actuelle",
        description: "Donne la météo du moment pour une ville. Paramètre : ville.",
        inputSchema: { type: "object", properties: { ville: { type: "string", maxLength: 80 } }, required: ["ville"] },
        // send : le nom de la ville est envoyé à un service en ligne (accord demandé par défaut).
        level: "send",
        handler: async (args, meta) => {
          const ville = String(args.ville ?? "").trim().slice(0, 80);
          if (!ville) return { status: "failed", text: { fr: "Il manque la ville.", en: "The city is missing." } };
          const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&name=${encodeURIComponent(ville)}`, { signal: meta.signal });
          const lieu = ((await geo.json()) as { results?: { name: string; latitude: number; longitude: number }[] }).results?.[0];
          if (!lieu) return { status: "failed", text: { fr: `Je ne trouve pas « ${ville} ».`, en: `I cannot find "${ville}".` } };
          const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lieu.latitude}&longitude=${lieu.longitude}&current=temperature_2m,weather_code`, { signal: meta.signal });
          if (!r.ok) return { status: "failed", text: { fr: "Le service météo ne répond pas.", en: "The weather service does not answer." } };
          const c = ((await r.json()) as { current?: { temperature_2m: number; weather_code: number } }).current;
          if (!c) return { status: "failed", text: { fr: "Réponse météo vide.", en: "Empty weather answer." } };
          const ciel = codeMeteo(c.weather_code);
          ctx.log("debug", `météo ${lieu.name} : ${c.temperature_2m} °C, code ${c.weather_code}`);
          return { status: "done", text: { fr: `${lieu.name} : ${Math.round(c.temperature_2m)} °C, ${ciel.fr}.`, en: `${lieu.name}: ${Math.round(c.temperature_2m)} °C, ${ciel.en}.` } };
        },
      },
    ]);
  },
};

export default plugin;
