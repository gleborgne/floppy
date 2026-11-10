// Plugin `tools` : passerelle MCP.
// - Gère les serveurs MCP de l'utilisateur (stdio hors processus, ou HTTP distant) et ajoute leurs outils au registre
//   du noyau, avec leur niveau (config > annotations > inconnu = write).
// - Chaque serveur est un « connecteur » (fournisseur d'éléments `connectors`, rubrique Connecteurs) : on peut
//   l'ajouter, le modifier, l'éteindre, le supprimer et choisir ses outils à chaud (voir connectors.ts).
// - Ouvre le serveur MCP « Floppy » pour les cerveaux CLI. Fournit le service `mcp` ({ url, token }).
import { z } from "zod";
import { definePlugin, Level } from "@floppy/core";
import { declareConnectors } from "./connectors.ts";
import { startFloppyMcp } from "./floppy-mcp.ts";

export type { McpEndpoint, ScopedEndpoint, ScopedOptions, ExtraTool } from "@floppy/contracts";
export { resolveLevel, levelFromConfig } from "./levels.ts";


const ServerConfig = z.object({
  /** Serveur local (processus enfant, stdio). */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  /** Serveur distant (MCP HTTP streamable). */
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /** Jeton Bearer pris via la CLI Azure (`az account get-access-token`). */
  auth: z.object({
    type: z.literal("azcli"),
    resource: z.string().regex(/^https?:\/\/[A-Za-z0-9._:\/-]+$/, "ressource invalide"),
  }).optional(),
  /** Nom affiché (défaut : la clé du serveur). */
  label: z.string().optional(),
  /** Note pour le cerveau, ajoutée à la description de chaque outil. */
  note: z.string().optional(),
  /** Service cloud : l'allumer à la voix demande un accord. */
  cloud: z.boolean().default(false),
  /** Niveau par outil ou par motif (« write_* »). `never` = interdit. */
  levels: z.record(z.string(), z.union([Level, z.literal("never")])).default({}),
  /** Serveur distant : croire ses outils marqués « lecture seule » (sans accord). Défaut : non. */
  trust_annotations: z.boolean().optional(),
  disabled: z.boolean().default(false),
  /** Si présent, seuls ces outils (noms ou motifs avec `*`) sont exposés. Appliqué avant `exclude`. */
  include: z.array(z.string()).optional(),
  /** Outils du serveur à ne pas exposer (ex. un faux ouvrir_url d'un serveur de test quand un corps fournit le vrai open_url). */
  exclude: z.array(z.string()).default([]),
}).refine((s) => Boolean(s.command) !== Boolean(s.url), { message: "un serveur a soit `command`, soit `url`" });

const Config = z.object({
  servers: z.record(z.string(), ServerConfig).default({}),
  /** Port du serveur MCP Floppy (0 = port libre). */
  port: z.number().int().min(0).max(65535).default(8740),
});
type Config = z.infer<typeof Config>;

export default definePlugin<Config>({
  manifest: {
    id: "tools",
    version: "0.2.0",
    licence: "MIT",
    sections: [
      { id: "connectors", order: 40, merge: true, label: { fr: "Connecteurs", en: "Connectors" }, description: { fr: "Ce que Floppy peut utiliser : serveurs MCP, commandes, applications.", en: "What Floppy can use: MCP servers, commands, applications." } },
    ],
    description: "Passerelle MCP : connecteurs de l'utilisateur (locaux ou distants) + serveur MCP Floppy pour les cerveaux CLI.",
    provides: ["mcp"],
    // Lance les serveurs MCP définis par l'utilisateur : ses commandes, son accord (il les a configurées).
    // net "*" : l'adresse d'un serveur MCP distant est choisie par l'utilisateur.
    permissions: { exec: ["*"], net: ["*"], cloud: true },
  },
  config: Config,
  async apply(ctx, cfg) {
    // Les serveurs de la config sont la base ; la fenêtre des réglages ajoute, modifie, éteint et supprime à chaud.
    const base = Object.fromEntries(Object.entries(cfg.servers).map(([k, v]) => [k, v as Record<string, unknown>]));
    const connectors = declareConnectors(ctx, base);
    ctx.effect(() => connectors.stop());
    const endpoint = await startFloppyMcp(ctx, cfg.port);
    // Les connecteurs se branchent en arrière-plan : le service `mcp` devient visible tout de suite (les cerveaux CLI
    // démarrent), et un connecteur qui traîne (30 s au plus) ne retarde pas le démarrage de Floppy.
    const connected = connectors.start().catch((e) => ctx.log("warn", `connecteurs : ${e instanceof Error ? e.message : String(e)}`));
    ctx.provide("mcp", { ...endpoint, connected: () => connected });
  },
});
