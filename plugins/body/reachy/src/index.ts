// Plugin `body-reachy` : corps Reachy Mini (adaptateur). Il parle au daemon Reachy en HTTP, se branche sur le
// hub comme un corps (émotions, gestes, outils corps) et déclare le fournisseur « reachy » (rubrique Corps).
// Robots : ceux de la config (`robots:`) + ceux ajoutés dans les réglages (ItemStore). Tout se fait à chaud.
import { z } from "zod";
import {
  definePlugin, T, TextError, tr, type ItemChild, type ItemInfo, type ItemKind, type OpResult, type Text,
} from "@floppy/core";
import type { BodyHub } from "@floppy/contracts";
import type { Capability } from "@floppy/protocol";
import { DaemonClient, DEFAULT_URL, normUrl, type DaemonStatus } from "./daemon.ts";
import { capabilitiesFor, RobotLink, type RobotValues } from "./link.ts";
import { GESTURES } from "./gestures.ts";

const Robot = z.object({
  name: z.string().default("Reachy Mini"),
  url: z.string().default(DEFAULT_URL),
  mic: z.enum(["robot", "pc"]).default("pc"),
  voice: z.string().default("same"),
  approve: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const Config = z.object({
  /** Robots de la config : id → réglages. Vide : on ajoute les robots dans la fenêtre des réglages. */
  robots: z.record(z.string(), Robot).default({}),
  /** Secondes entre deux essais quand le daemon ne répond pas (et entre deux vérifications). */
  retry_s: z.number().min(0.05).default(10),
  /** Vitesse des gestes (1 = normal). Pour les tests. */
  pace: z.number().min(0).default(1),
});
type Config = z.infer<typeof Config>;

const KIND: ItemKind = {
  id: "reachy",
  label: "Reachy Mini",
  description: {
    fr: "Robot de bureau : tête et antennes. Floppy se connecte au daemon du robot (ou du simulateur) sur le réseau.",
    en: "Desktop robot: head and antennas. Floppy connects to the robot's (or simulator's) daemon over the network.",
  },
  fields: [
    { key: "name", label: { fr: "Nom", en: "Name" }, type: "text", required: true, default: "Reachy Mini", placeholder: T("Reachy Mini (bureau)", "Reachy Mini (desk)") },
    {
      key: "url", label: { fr: "Adresse du robot", en: "Robot address" }, type: "text", required: true, default: DEFAULT_URL,
      placeholder: DEFAULT_URL,
      hint: { fr: "Le simulateur répond sur http://localhost:8000.", en: "The simulator answers on http://localhost:8000." },
    },
    {
      key: "mic", label: { fr: "Micro à utiliser", en: "Microphone" }, type: "select", default: "pc",
      options: [
        { value: "robot", label: { fr: "Micro du robot", en: "Robot microphone" } },
        { value: "pc", label: { fr: "Micro du PC (le robot ne fait que bouger)", en: "PC microphone (the robot only moves)" } },
      ],
      hint: {
        fr: "Le micro du robot n'est pas encore branché (pas de pont audio) : pour l'instant le micro du PC est utilisé.",
        en: "The robot microphone is not wired yet (no audio bridge): the PC microphone is used for now.",
      },
    },
    {
      key: "voice", label: { fr: "Voix sur ce corps", en: "Voice on this body" }, type: "select", default: "same",
      options: [{ value: "same", label: { fr: "Même voix que le PC", en: "Same voice as the PC" } }],
    },
    {
      key: "approve", label: { fr: "Peut répondre aux demandes d'accord", en: "Can answer approval requests" }, type: "boolean", default: true,
      hint: { fr: "Le robot signale la demande par un geste ; la réponse à la voix passe par le corps vocal.", en: "The robot signals the request with a gesture; the spoken answer goes through the voice body." },
    },
  ],
};

const CAP_LABEL: Record<string, Text> = {
  emotion: { fr: "Émotions (tête, antennes)", en: "Emotions (head, antennas)" },
  gesture: { fr: "Gestes : hocher la tête, danser…", en: "Gestures: nod, dance…" },
  approval: { fr: "Accord (demande signalée par un geste)", en: "Approval (request signalled by a gesture)" },
  voice: { fr: "Voix (micro et haut-parleur du robot)", en: "Voice (robot microphone and speaker)" },
};

function children(caps: Capability[]): ItemChild[] {
  return caps.map((c) => ({ id: c, label: CAP_LABEL[c] ?? c, enabled: true }));
}

/** Valide et complète les valeurs d'un formulaire. */
function clean(raw: Record<string, unknown>): RobotValues & { enabled: boolean } {
  const r = Robot.parse({
    ...raw,
    ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : { name: undefined }),
    ...(typeof raw.url === "string" && raw.url.trim() ? { url: raw.url.trim() } : { url: undefined }),
  });
  return { ...r, url: normUrl(r.url) };
}

const errText = (e: unknown): Text => (e instanceof TextError ? e.text : e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e));

/** Candidats de la détection automatique. */
export const DETECT_URLS = ["http://reachy-mini.local:8000", "http://localhost:8000"];

export default definePlugin<Config>({
  manifest: {
    id: "body-reachy",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "corps", label: { fr: "Corps et affichage", en: "Bodies and display" } },
    ],
    description: "Corps Reachy Mini : émotions et gestes de la tête et des antennes, via le daemon HTTP du robot ou du simulateur.",
    inject: ["body"],
    permissions: { net: ["reachy-mini.local", "localhost"] },
  },
  config: Config,
  apply(ctx, cfg) {
    const hub: BodyHub = ctx.get("body");
    const store = ctx.items.store();
    const links = new Map<string, { link: RobotLink; sig: string }>();

    const all = () => store.merge(cfg.robots as Record<string, Record<string, unknown>>) as Record<string, Record<string, unknown>>;
    const valuesOf = (id: string) => { const r = all()[id]; return r ? clean(r) : undefined; };
    const isOn = (id: string) => store.isEnabled(id) && valuesOf(id)?.enabled !== false;

    /** Aligne les connexions sur la liste voulue (ajout, modif, désactivation, suppression à chaud). */
    const reconcile = () => {
      const want = new Map<string, RobotValues>();
      for (const id of Object.keys(all())) { const v = valuesOf(id); if (v && isOn(id)) want.set(id, v); }
      for (const [id, e] of [...links]) {
        const v = want.get(id);
        if (!v || JSON.stringify(v) !== e.sig) { e.link.stop(); links.delete(id); }
      }
      for (const [id, v] of want) {
        if (links.has(id)) continue;
        const link = new RobotLink(id, v, {
          hub, log: (l, t) => ctx.log(l, t), changed: () => ctx.items.changed(),
          retryMs: cfg.retry_s * 1000, pace: cfg.pace,
        });
        links.set(id, { link, sig: JSON.stringify(v) });
        link.start();
      }
      ctx.items.changed();
    };

    ctx.effect(() => { for (const e of links.values()) e.link.stop(); links.clear(); });

    const info = (id: string): ItemInfo => {
      const raw = all()[id]!;
      const v = clean(raw);
      const on = isOn(id);
      const link = links.get(id)?.link;
      const up = on && link?.state === "up";
      let status: ItemInfo["status"] = "off";
      let statusText: Text = { fr: "Désactivé", en: "Disabled" };
      if (on && up) {
        status = "ok";
        const sim = link?.status?.simulation_enabled;
        statusText = sim
          ? { fr: "Branché (simulateur)", en: "Connected (simulator)" }
          : { fr: "Branché", en: "Connected" };
      } else if (on && link?.state === "down") {
        status = "error";
        const s = Math.round(cfg.retry_s * 10) / 10;
        statusText = { fr: `Injoignable (nouvel essai toutes les ${s} s)`, en: `Unreachable (retrying every ${s} s)` };
      } else if (on) {
        status = "loading";
        statusText = { fr: "Connexion…", en: "Connecting…" };
      }
      return {
        id, label: v.name, detail: v.url, enabled: on, active: up, status, statusText, kind: "reachy",
        tags: ["reachy", ...(up ? (link?.caps ?? []) : [])], values: { name: v.name, url: v.url, mic: v.mic, voice: v.voice, approve: v.approve },
        editable: true, removable: true, toggleable: true,
        ...(up && link ? { children: children(link.caps), childrenLabel: { fr: "Ce que le robot sait faire", en: "What the robot can do" } } : {}),
        actions: up ? [{ id: "nod", label: { fr: "Hocher la tête", en: "Nod" } }, { id: "joy", label: { fr: "Montrer « joie »", en: "Show “joy”" } }] : [],
        aliases: [v.name, "reachy", "robot"],
      };
    };

    const probe = async (url: string): Promise<{ ok: true; st: DaemonStatus } | { ok: false; why: Text }> => {
      try {
        const st = await new DaemonClient(url, 3000).status();
        if (st.state && st.state !== "running") return { ok: false, why: T(`le daemon répond mais n'est pas prêt (${st.state})`, `the daemon answers but is not ready (${st.state})`) };
        return { ok: true, st };
      } catch (e) {
        return { ok: false, why: errText(e) };
      }
    };

    ctx.items.declare({
      id: "reachy",
      section: "corps",
      label: "Reachy Mini",
      description: { fr: "Robots Reachy Mini (ou simulateur) branchés comme corps.", en: "Reachy Mini robots (or simulator) plugged in as bodies." },
      order: 20,
      kinds: [KIND],
      addLabel: { fr: "Ajouter un Reachy Mini", en: "Add a Reachy Mini" },
      list: () => Object.keys(all()).map(info),

      async add(_kind, values) {
        const v = clean(values);
        const id = store.add("reachy", { ...v } as Record<string, unknown>, v.name, Object.keys(cfg.robots));
        reconcile();
        return { ok: true, id, text: T(`${v.name} ajouté.`, `${v.name} added.`) };
      },
      async update(id, values) {
        if (!all()[id]) return { ok: false, text: T("Robot inconnu.", "Unknown robot.") };
        const v = clean({ ...all()[id], ...values });
        store.update(id, { name: v.name, url: v.url, mic: v.mic, voice: v.voice, approve: v.approve });
        reconcile();
        return { ok: true, id, text: T(`${v.name} modifié.`, `${v.name} updated.`) };
      },
      async remove(id) {
        if (!all()[id]) return { ok: false, text: T("Robot inconnu.", "Unknown robot.") };
        store.remove(id);
        reconcile();
        return { ok: true, text: T("Robot supprimé.", "Robot removed.") };
      },
      async setEnabled(id, on) {
        if (!all()[id]) return { ok: false, text: T("Robot inconnu.", "Unknown robot.") };
        store.setEnabled(id, on);
        reconcile();
        return { ok: true, text: on ? T("Robot activé.", "Robot enabled.") : T("Robot désactivé : il n'est plus branché.", "Robot disabled: it is no longer connected.") };
      },

      async test(_kind, values, id) {
        const base = id && all()[id] ? { ...all()[id], ...values } : values;
        const v = clean(base);
        const r = await probe(v.url);
        if (!r.ok) return { ok: false, text: T(`Injoignable (${v.url}) : ${tr(r.why, "fr")}.`, `Unreachable (${v.url}): ${tr(r.why, "en")}.`) };
        const caps = capabilitiesFor(v, r.st);
        const sim = r.st.simulation_enabled || r.st.mockup_sim_enabled;
        const robot = r.st.robot_name ?? "Reachy";
        const can = (l: string) => caps.map((c) => tr(CAP_LABEL[c] ?? c, l)).join(", ");
        const text = T(
          `Connecté à ${robot}${sim ? " (simulateur : pas d'audio)" : ""}. Le robot sait : ${caps.join(", ")}.`,
          `Connected to ${robot}${sim ? " (simulator: no audio)" : ""}. The robot can do: ${can("en")}.`,
        );
        return { ok: true, text, children: children(caps) };
      },

      async action(id, action) {
        if (action === "detect") {
          const found: ItemChild[] = [];
          const seen = new Set<string>();
          await Promise.all(DETECT_URLS.map(async (u) => {
            const r = await probe(u);
            if (r.ok && !seen.has(u)) {
              seen.add(u);
              const sim = r.st.simulation_enabled || r.st.mockup_sim_enabled;
              found.push({ id: u, label: r.st.robot_name ?? "Reachy Mini", detail: sim ? T(`${u} (simulateur)`, `${u} (simulator)`) : u, enabled: true });
            }
          }));
          found.sort((a, b) => DETECT_URLS.indexOf(a.id) - DETECT_URLS.indexOf(b.id));
          return found.length
            ? { ok: true, text: T(`${found.length} robot(s) trouvé(s).`, `${found.length} robot(s) found.`), children: found }
            : { ok: false, text: T(`Aucun robot trouvé (${DETECT_URLS.join(", ")}).`, `No robot found (${DETECT_URLS.join(", ")}).`), children: [] };
        }
        const link = links.get(id)?.link;
        if (!link || link.state !== "up") return { ok: false, text: T("Le robot n'est pas branché.", "The robot is not connected.") };
        const g = action === "nod" ? "nod" : action === "joy" ? "happy" : undefined;
        if (!g || !GESTURES[g]) return { ok: false, text: T(`Action inconnue : ${action}.`, `Unknown action: ${action}.`) };
        const ok = await link.play(g, "high");
        const r: OpResult = ok ? { ok: true, text: T("Fait.", "Done.") } : { ok: false, text: T("Le robot n'a pas bougé.", "The robot did not move.") };
        return r;
      },
    });

    reconcile();
  },
});
