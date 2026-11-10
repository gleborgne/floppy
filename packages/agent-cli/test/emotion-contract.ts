// Contrat des étiquettes d'émotion des cerveaux CLI (Claude, Codex, Antigravity), joué avec un faux CLI qui rejoue un flux.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, definePlugin, type Context, type PluginDef } from "@floppy/core";
import type { BrainEvent, LlmService } from "@floppy/contracts";
import { borrowAgent } from "../src/offers.ts";

/** Étape d'un flux simulé : un morceau de texte, ou un appel d'outil (le texte suivant est un nouveau segment). */
export type Step = { text: string } | { tool: string };

export interface EmotionContractOptions {
  plugin: PluginDef<any>;
  /** Identifiant de l'agent offert (« claude », « codex », « antigravity »). */
  agent: string;
  /** Élément choisi pour le cerveau principal (« claude », « codex », « antigravity »). */
  slot: string;
  /** Faux CLI qui comprend « script:<JSON> » et « prompt ». */
  fixture: string;
  /** Traduit les étapes dans le script lu par le faux CLI. */
  script: (steps: Step[]) => string;
}

/** Texte et émotions d'un tour, textes consécutifs collés. */
type Seen = ({ emotion: string; intensity?: number } | { text: string })[];

export function emotionContract(o: EmotionContractOptions) {
  const tested = { ...o.plugin, manifest: { ...o.plugin.manifest, permissions: { ...o.plugin.manifest.permissions, exec: ["node"] } } };
  const boot = async (emotions: boolean, language = "fr") => {
    let consumer: Context | undefined;
    let main: LlmService | undefined;
    const mcp = definePlugin({ manifest: { id: "test-mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
      ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) });
    } });
    const probe = definePlugin({
      manifest: { id: "probe", version: "0", licence: "MIT", optional: ["agent"], slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" }] },
      async apply(ctx) { consumer = ctx; main = await ctx.slot<LlmService>("brain.main"); },
    });
    const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "emotion-cli-")), logger: () => {}, plugins: [tested, mcp, probe] });
    await k.applyConfig({ assistant: { name: "Floppy", language, wake_words: ["floppy"] }, slots: { "brain.main": `a/${o.slot}` }, plugins: [
      { id: "mcp", plugin: "test-mcp" },
      { id: "a", plugin: o.plugin.manifest.id, config: { exe: process.execPath, exeArgs: [o.fixture], userMcp: false, timeout_s: 5, emotions } },
      { id: "probe", plugin: "probe" },
    ] });
    const brain = main!.agent!;
    const run = async (text: string) => {
      const events: BrainEvent[] = [];
      for await (const ev of brain.run({ text, session: "s", mode: "voice" })) events.push(ev);
      const seen: Seen = [];
      for (const ev of events) {
        const last = seen.at(-1);
        if (ev.type === "text") { if (last && "text" in last) last.text += ev.delta; else seen.push({ text: ev.delta }); }
        else if (ev.type === "emotion") seen.push(ev.intensity === undefined ? { emotion: ev.emotion } : { emotion: ev.emotion, intensity: ev.intensity });
      }
      const done = events.find((e) => e.type === "done");
      return { events, seen, done: done?.type === "done" ? done.text : "" };
    };
    return { k, run, consumer: () => consumer! };
  };
  const play = async (steps: Step[], emotions = true) => {
    const b = await boot(emotions);
    try { return await b.run(`script:${o.script(steps)}`); } finally { await b.k.stopAll(); }
  };

  describe(`${o.agent} : étiquettes d'émotion`, () => {
    it("tête de réponse : l'émotion sort avant le texte, sans étiquette", async () => {
      const r = await play([{ text: "[joie] Bonne nouvelle !" }]);
      expect(r.seen).toEqual([{ emotion: "joy" }, { text: "Bonne nouvelle !" }]);
      expect(r.done).toBe("Bonne nouvelle !");
    });
    it("au milieu de la réponse, à sa place", async () => {
      const r = await play([{ text: "[content] C'est fait. [malicieux] Et j'ai rangé." }]);
      expect(r.seen).toEqual([{ emotion: "happy" }, { text: "C'est fait. " }, { emotion: "mischief" }, { text: "Et j'ai rangé." }]);
      expect(r.done).toBe("C'est fait. Et j'ai rangé.");
    });
    it("étiquette coupée entre deux morceaux du flux", async () => {
      const r = await play([{ text: "[jo" }, { text: "ie] Salut. [surp" }, { text: "ris] Oh !" }]);
      expect(r.seen).toEqual([{ emotion: "joy" }, { text: "Salut. " }, { emotion: "surprised" }, { text: "Oh !" }]);
    });
    it("intensité : [joie+]", async () => {
      expect((await play([{ text: "[joie+] Youpi" }])).seen).toEqual([{ emotion: "joy", intensity: 1.25 }, { text: "Youpi" }]);
    });
    it("un crochet qui n'est pas une émotion reste dans le texte", async () => {
      const r = await play([{ text: "[content] Voir la note [1] et [annexe]." }]);
      expect(r.seen).toEqual([{ emotion: "happy" }, { text: "Voir la note [1] et [annexe]." }]);
      expect(r.done).toBe("Voir la note [1] et [annexe].");
    });
    it("après un outil, nouveau segment : l'étiquette de tête revient, rien ne se perd", async () => {
      const r = await play([{ text: "[content] Je cherche." }, { tool: "agenda_du_jour" }, { text: "[fier] Trouvé !" }]);
      expect(r.seen).toEqual([{ emotion: "happy" }, { text: "Je cherche. " }, { emotion: "proud" }, { text: "Trouvé !" }]);
      expect(r.events.some((e) => e.type === "tool" && e.name === "agenda_du_jour")).toBe(true);
      expect(r.done).not.toMatch(/[[\]]/);
    });
    it("étiquette en attente à la fin du flux : rendue comme texte, jamais perdue", async () => {
      const r = await play([{ text: "Un début [jo" }]);
      expect(r.seen).toEqual([{ text: "Un début [jo" }]);
      expect(r.done).toBe("Un début [jo");
    });
    it("réglage coupé : texte intact, aucun événement d'émotion", async () => {
      const r = await play([{ text: "[joie] Salut" }], false);
      expect(r.seen).toEqual([{ text: "[joie] Salut" }]);
      expect(r.done).toBe("[joie] Salut");
    });
    it("le prompt demande les étiquettes dans la langue de l'assistant ; coupé : rien", async () => {
      for (const [lang, expected] of [["fr", "ton émotion entre crochets"], ["en", "emotion in square brackets"]] as const) {
        const b = await boot(true, lang);
        try { expect((await b.run("prompt")).done).toContain(expected); } finally { await b.k.stopAll(); }
      }
      const off = await boot(false);
      try { expect((await off.run("prompt")).done).not.toMatch(/crochets|square brackets/); } finally { await off.k.stopAll(); }
    });
    it("une mission d'agent (sans visage ni voix) n'a ni consigne ni filtre", async () => {
      const b = await boot(true);
      try {
        const agent = await borrowAgent(b.consumer(), o.agent);
        let text = "";
        for await (const ev of agent!.service.run!({ text: "prompt", mode: "text", session: "m" })) if (ev.type === "done") text = ev.text;
        expect(text).not.toMatch(/crochets|square brackets/);
        expect(text.length).toBeGreaterThan(20);
      } finally { await b.k.stopAll(); }
    });
  });
}
