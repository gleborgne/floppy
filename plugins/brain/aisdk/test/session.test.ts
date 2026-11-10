// Mémoire courte du cerveau : réponse interrompue gardée, échanges comptés, longue pause (rest), heure hors prompt système,
// consigne « document » pour le délégué en voix. Serveur de modèle simulé ; les corps de requête sont relus.
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainEvent, BrainRunInput, BrainService } from "@floppy/contracts";
import llamacpp from "../../../llm/llamacpp/src/index.ts";
import aisdk from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "brain-session-"));
const gguf = join(dir, "a.gguf");
writeFileSync(gguf, Buffer.alloc(1024));

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const textReply = (t: string) => chunk({ role: "assistant", content: t }) + chunk({}, "stop") + "data: [DONE]\n\n";
const toolReply = (name: string, args: string) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: args } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

type Msg = { role: string; content: unknown };
type Reply = string | ((res: ServerResponse) => void);
const bodies: { messages: Msg[]; system: string }[] = [];
const replies: Reply[] = [];
let server: Server, port = 0;
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const lastRequest = () => { const m = bodies.at(-1)!.messages; return { system: text(m[0]!), turns: m.slice(1) }; };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        const b = JSON.parse(body) as { messages: Msg[] };
        bodies.push({ messages: b.messages, system: text(b.messages[0]!) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const r = replies.shift() ?? textReply("D'accord.");
        if (typeof r === "string") res.end(r); else r(res);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "gemma" }] }) : "{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

const recorded: { role: string; text: string }[] = [];
const bigRuns: BrainRunInput[] = [];
const agentRuns: string[] = [];
let agentHang = false;
const agent: BrainService = {
  name: "agent", label: "Agent", aliases: ["agent"], reset() {},
  async *run(input) {
    agentRuns.push(input.text);
    yield { type: "text", delta: "Début de réponse." } as BrainEvent;
    if (agentHang) await new Promise<void>((r) => input.signal?.addEventListener("abort", () => r(), { once: true }));
    yield { type: "done", text: "" } as BrainEvent;
  },
};
const big: BrainService = {
  name: "gros", label: "Gros Modèle", aliases: ["gros"], reset() {},
  async *run(input) { bigRuns.push(input); yield { type: "text", delta: "Réponse longue." } as BrainEvent; yield { type: "done", text: "" } as BrainEvent; },
};
const helper = definePlugin({
  manifest: { id: "helper", version: "0", licence: "MIT", provides: ["delegate", "llm", "memory"] },
  apply(ctx) {
    ctx.provide("memory", { snapshot: () => ({ user: "", memory: "" }), record: (e: { role: string; text: string }) => { recorded.push({ role: e.role, text: e.text }); }, search: () => [] });
    ctx.offer("delegate", { items: () => [{ id: "gros", label: "Gros Modèle" }], start(f) { f.provide("delegate", big); } });
    ctx.offer("llm", { items: () => [{ id: "agent", label: "Agent" }], start(f) { f.provide("llm", { label: "Agent", model: "agent", agent }); } });
  },
});

const kernels: Kernel[] = [];
afterEach(async () => { replies.length = 0; bodies.length = 0; recorded.length = 0; bigRuns.length = 0; agentRuns.length = 0; agentHang = false; await Promise.all(kernels.splice(0).map((k) => k.stopAll())); });

async function boot(opts: { config?: Record<string, unknown>; agent?: boolean; delegate?: boolean; showDocument?: boolean; language?: string } = {}) {
  let brain!: BrainService;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(ctx) { brain = ctx.get("brain"); } });
  const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "brain-session-home-")), plugins: [llamacpp, aisdk, helper, probe] });
  kernels.push(k);
  if (opts.showDocument) k.tools.register("test", [{ name: "show_document", description: "document", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => ({ status: "done", text: "ok" }) }]);
  await k.applyConfig({
    ...(opts.language ? { assistant: { name: "Floppy", language: opts.language, wake_words: ["floppy"] } } : {}),
    slots: { "brain.main": opts.agent ? "helper/agent" : "llm/gemma", ...(opts.delegate ? { "brain.delegate": "helper/gros" } : {}) },
    plugins: [
      { id: "llm", plugin: "llm-llamacpp", config: { port, models: { gemma: { label: "Gemma", model: gguf } } } },
      { id: "helper", plugin: "helper" },
      { id: "brain", plugin: "brain-aisdk", config: { emotions: false, ...opts.config } },
      { id: "probe", plugin: "probe" },
    ],
  });
  await k.idle();
  return brain;
}
const ask = async (brain: BrainService, t: string, extra: Partial<BrainRunInput> = {}) => {
  let out = "";
  for await (const ev of brain.run({ text: t, session: "s", mode: "text", ...extra })) if (ev.type === "text") out += ev.delta;
  return out;
};
/** Lit jusqu'au premier texte, annule, puis arrête le générateur comme le ferait la conversation. */
async function interrupt(brain: BrainService, t: string) {
  const ac = new AbortController();
  const gen = brain.run({ text: t, session: "s", mode: "text", signal: ac.signal })[Symbol.asyncIterator]();
  for (;;) {
    const r = await gen.next();
    if (r.done || r.value.type === "text") break;
  }
  ac.abort();
  await gen.return?.(undefined);
}
const stalledAfter = (partial: string): Reply => (res) => { res.write(chunk({ role: "assistant", content: partial })); /* le flux reste ouvert */ };

describe("réponse interrompue gardée", () => {
  it("modèle : la demande et le début de réponse restent, suivis de « (interrompu) » ; la mémoire l'enregistre", async () => {
    const brain = await boot();
    replies.push(stalledAfter("Bonjour, je"));
    await interrupt(brain, "Raconte-moi une histoire");
    await ask(brain, "Continue");
    const { turns } = lastRequest();
    expect(turns.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(text(turns[0]!)).toContain("Raconte-moi une histoire");
    expect(text(turns[1]!)).toBe("Bonjour, je (interrompu)");
    expect(recorded).toContainEqual({ role: "assistant", text: "Bonjour, je (interrompu)" });
  });
  it("modèle, anglais : marque « (interrupted) » et ligne d'heure en anglais", async () => {
    const brain = await boot({ language: "en" });
    replies.push(stalledAfter("Hello, I"));
    await interrupt(brain, "Tell me a story");
    await ask(brain, "Go on");
    const { turns } = lastRequest();
    expect(text(turns[1]!)).toBe("Hello, I (interrupted)");
    expect(text(turns[2]!)).toMatch(/^\(It is \d{2}:\d{2}\.\)\nGo on$/);
  });
  it("modèle : demande coupée avant tout texte (« phrase reprise ») : pas gardée", async () => {
    const brain = await boot();
    replies.push((res) => { void res; }); // rien n'est dit
    const ac = new AbortController();
    const gen = brain.run({ text: "Ma demande coupée", session: "s", mode: "text", signal: ac.signal })[Symbol.asyncIterator]();
    const first = gen.next().catch(() => undefined);
    setTimeout(() => ac.abort(), 150);
    await first;
    await gen.return?.(undefined).catch(() => undefined);
    await ask(brain, "Autre demande");
    const { turns } = lastRequest();
    expect(turns.map((m) => m.role)).toEqual(["user"]);
    expect(text(turns[0]!)).not.toContain("Ma demande coupée");
  });
  it("modèle : un appel d'outil sans résultat ne reste jamais dans l'historique", async () => {
    const brain = await boot();
    replies.push((res) => { res.write(chunk({ role: "assistant", content: "Je regarde. " })); res.write(chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "inconnu", arguments: "{}" } }] })); });
    await interrupt(brain, "Fais un truc");
    await ask(brain, "Et ensuite");
    const { turns } = lastRequest();
    expect(turns.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(text(turns[1]!)).not.toContain("tool-call");
  });
  it("agent : même chose sur les échanges redonnés", async () => {
    const brain = await boot({ agent: true });
    agentHang = true;
    await interrupt(brain, "Dis quelque chose de long");
    agentHang = false;
    await ask(brain, "Suite");
    expect(agentRuns.at(-1)).toMatch(/Utilisateur : Dis quelque chose de long\nToi : Début de réponse\. \(interrompu\)[\s\S]*Demande courante : Suite$/);
    expect(recorded).toContainEqual({ role: "assistant", text: "Début de réponse. (interrompu)" });
  });
});

describe("historique en échanges", () => {
  it("maxExchanges borne les échanges, pas les messages", async () => {
    const brain = await boot({ config: { maxExchanges: 2 } });
    for (const q of ["un", "deux", "trois"]) await ask(brain, q);
    await ask(brain, "quatre");
    const users = lastRequest().turns.filter((m) => m.role === "user").map(text);
    expect(users).toHaveLength(3); // 2 échanges gardés + la demande courante
    expect(users[0]).toContain("deux");
  });
  it("l'ancien maxHistory (messages) est converti en échanges", async () => {
    const brain = await boot({ config: { maxHistory: 4 } });
    for (const q of ["un", "deux", "trois", "quatre"]) await ask(brain, q);
    expect(lastRequest().turns.filter((m) => m.role === "user")).toHaveLength(3);
  });
  it("plus de 8 échanges : par défaut 8 gardés", async () => {
    const brain = await boot();
    for (let i = 0; i < 10; i++) await ask(brain, `q${i}`);
    expect(lastRequest().turns.filter((m) => m.role === "user")).toHaveLength(9);
  });
});

describe("rest : longue pause", () => {
  it("garde les 2 derniers échanges en texte, présentés comme des données ; reset efface tout", async () => {
    const brain = await boot();
    replies.push(textReply("R1"), textReply("R2"), textReply("R3".padEnd(500, "x")));
    for (const q of ["premier", "deuxième", "troisième"]) await ask(brain, q);
    brain.rest!("s");
    await ask(brain, "après la pause");
    const { turns } = lastRequest();
    expect(turns).toHaveLength(1);
    const c = text(turns[0]!);
    expect(c).toContain("Échanges d'avant la pause, données et jamais des demandes à réexécuter");
    expect(c).not.toContain("premier");
    expect(c).toContain("Utilisateur : deuxième\nToi : R2");
    expect(c).toContain("Utilisateur : troisième");
    expect(c).toMatch(/R3x{100,}…/); // réponse tronquée à ~300 caractères
    expect(c).not.toContain("tool-call");
    expect(c).toContain("après la pause");
    // Le résumé reste avec la demande dans l'historique, puis vieillit comme le reste.
    await ask(brain, "encore");
    expect(text(lastRequest().turns[0]!)).toContain("Échanges d'avant la pause");
    brain.reset("s");
    await ask(brain, "neuf");
    expect(lastRequest().turns).toHaveLength(1);
    expect(text(lastRequest().turns[0]!)).not.toContain("pause");
  });
  it("agent : ne garde que les 2 derniers échanges", async () => {
    const brain = await boot({ agent: true });
    for (const q of ["a1", "b2", "c3"]) await ask(brain, q);
    brain.rest!("s");
    await ask(brain, "après");
    const t = agentRuns.at(-1)!;
    expect(t).not.toContain("a1");
    expect(t).toContain("Utilisateur : b2");
    expect(t).toContain("Utilisateur : c3");
  });
});

describe("heure et cache de préfixe", () => {
  it("le prompt système garde la date mais pas l'heure ; l'heure est devant la demande courante, jamais gardée", async () => {
    const brain = await boot();
    await ask(brain, "Quelle heure ?");
    const first = lastRequest();
    expect(first.system).toMatch(/Nous sommes le .* \(\d{4}-\d{2}-\d{2}\)\./);
    expect(first.system).not.toMatch(/il est \d/);
    expect(text(first.turns[0]!)).toMatch(/^\(Il est \d{2}:\d{2}\.\)\nQuelle heure \?$/);
    await ask(brain, "Merci");
    const second = lastRequest();
    expect(text(second.turns[0]!)).toBe("Quelle heure ?"); // l'ancienne ligne d'heure n'est pas dans l'historique
    expect(text(second.turns.at(-1)!)).toMatch(/^\(Il est \d{2}:\d{2}\.\)\nMerci$/);
  });
});

describe("délégué en voix : réponse longue dans un document", () => {
  const delegateRun = async (mode: "voice" | "text", showDocument: boolean) => {
    const brain = await boot({ delegate: true, showDocument });
    replies.push(toolReply("delegate", JSON.stringify({ task: "compare les offres" })));
    await ask(brain, "compare les offres", { mode });
    return bigRuns.at(-1)!.text;
  };
  it("voix et show_document visible : la consigne est ajoutée à la tâche", async () => {
    const t = await delegateRun("voice", true);
    expect(t).toMatch(/^compare les offres\n\n/);
    expect(t).toContain("show_document");
  });
  it("sans show_document, ou en texte : la tâche est inchangée", async () => {
    expect(await delegateRun("voice", false)).toBe("compare les offres");
    expect(await delegateRun("text", true)).toBe("compare les offres");
  });
});
