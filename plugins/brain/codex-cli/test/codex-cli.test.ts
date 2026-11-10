// Brain codex-cli : un élément par modèle (cerveau et délégué), app-server bridé (seulement le MCP Floppy),
// un fil par session, accords du CLI refusés, annulation.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainService, BrainRunInput, LlmService } from "@floppy/contracts";
import codex, { codexOverrides } from "../src/index.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");

async function collect(b: BrainService, text: string, session = "s", extra: Partial<BrainRunInput> = {}) {
  let out = "";
  const tools: string[] = [];
  let info: Record<string, unknown> = {};
  for await (const ev of b.run({ text, session, mode: "text", ...extra })) {
    if (ev.type === "text") out += ev.delta;
    else if (ev.type === "tool") tools.push(ev.name);
    else if (ev.type === "done") info = ev.info ?? {};
  }
  return { out, tools, info };
}

describe("codexOverrides", () => {
  it("coupe shell, web, plugins ; seul le MCP Floppy, ses outils approuvés", () => {
    const c = codexOverrides("http://127.0.0.1:1/mcp", ["agenda_du_jour"], ["github"]).join(" ");
    for (const f of ["shell_tool", "unified_exec", "plugins", "browser_use", "computer_use", "memories"]) expect(c).toContain(`features.${f}=false`);
    expect(c).toContain("mcp_servers.github.enabled=false");
    expect(c).toContain('mcp_servers.floppy={url="http://127.0.0.1:1/mcp",bearer_token_env_var="FLOPPY_MCP_TOKEN",tools={agenda_du_jour={approval_mode="approve"}}}');
    expect(c).toContain('web_search="disabled"');
    expect(c).toContain('sandbox_mode="read-only"');
  });
});

describe("brain codex-cli", () => {
  let k: Kernel | undefined;
  afterEach(async () => { await k?.stopAll(); k = undefined; });

  async function boot(slots: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "codex-cli-"));
    // Le manifeste n'autorise que « codex » : on copie node sous ce nom.
    const fakeExe = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
    copyFileSync(process.execPath, fakeExe);
    let dlg: BrainService | undefined;
    let main: LlmService | undefined;
    const probe = definePlugin({
      manifest: { id: "probe", version: "0", licence: "MIT", slots: [
        { id: "brain.delegate", service: "delegate", section: "brain", label: "Délégation", none: "Aucune" },
        { id: "brain.main", service: "llm", section: "brain", label: "Cerveau" },
      ] },
      async apply(ctx) { dlg = await ctx.slot<BrainService>("brain.delegate"); main = await ctx.slot<LlmService>("brain.main"); },
    });
    const mcp = definePlugin({
      manifest: { id: "fakemcp", version: "0", licence: "MIT", provides: ["mcp"] },
      apply(ctx) { ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) }); },
    });
    const kernel = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [codex, probe, mcp] });
    k = kernel;
    await kernel.applyConfig({ slots, plugins: [
      { id: "mcp", plugin: "fakemcp" },
      { id: "x", plugin: "brain-codex-cli", config: { exe: fakeExe, exeArgs: [fixture], userMcp: false, timeout_s: 5 } },
      { id: "probe", plugin: "probe" },
    ] });
    return { dlg: () => dlg, main: () => main, k: kernel };
  }

  it("un seul élément ; modèle choisi dans sa page ; cerveau principal = agent ; app-server bridé", async () => {
    const b = await boot({ "brain.main": "x/codex", "brain.delegate": "x/codex" });
    const opts = b.k.settings.list().find((s) => s.key === "slot.brain.main")!.options!.map((o) => o.value);
    expect(opts).toEqual(["x/codex"]);
    const main = b.main()!;
    expect(main).toMatchObject({ label: "GPT-6.1 Sol", model: "gpt-6.1-sol", cloud: true });
    expect(b.dlg()!.name).toBe("codex:gpt-6.1-sol");
    // Un modèle pour le cerveau principal, un autre pour la délégation.
    const prov = b.k.items.provider("codex-cli")!;
    expect((await prov.update!("codex", { model: "gpt-6.1-terra", delegateModel: "gpt-6.1-sol" })).ok).toBe(true);
    expect(main).toMatchObject({ label: "GPT-6.1 Terra", model: "gpt-6.1-terra" });
    expect(b.dlg()!.name).toBe("codex:gpt-6.1-sol");
    expect((await prov.list())[0]).toMatchObject({ id: "codex", values: { model: "gpt-6.1-terra", delegateModel: "gpt-6.1-sol" } });
    const r = await collect(main.agent!, "bonjour");
    const got = JSON.parse(r.out);
    expect(got).toMatchObject({ model: "gpt-6.1-terra", sandbox: "read-only", policy: "never", hasPrompt: true });
    expect(got.args[0]).toBe("app-server");
    expect(got.args.join(" ")).toContain("features.shell_tool=false");
  });

  it("un fil par session, oublié au reset", async () => {
    const a = (await boot({ "brain.main": "x/codex" })).main()!.agent!;
    const t1 = JSON.parse((await collect(a, "un", "s1")).out).thread;
    expect(JSON.parse((await collect(a, "deux", "s1")).out).thread).toBe(t1);
    expect(JSON.parse((await collect(a, "trois", "s2")).out).thread).not.toBe(t1);
    a.reset("s1");
    expect(JSON.parse((await collect(a, "quatre", "s1")).out).thread).not.toBe(t1);
  });

  it("transmet le ton au début et aux changements, l'historique seulement à l'ouverture", async () => {
    const a = (await boot({ "brain.main": "x/codex" })).main()!.agent!;
    expect(a.keepsHistory).toBe(true);
    const options = { tone: "joueur", history: [{ role: "user" as const, text: "souvenir" }] };
    const first = JSON.parse((await collect(a, "un", "s", options)).out);
    expect(first.text).toContain("joueur");
    expect(first.text).toContain("souvenir");
    const next = JSON.parse((await collect(a, "deux", "s", options)).out);
    expect(next.thread).toBe(first.thread);
    expect(next.text).toBe("deux");
    const changed = JSON.parse((await collect(a, "trois", "s", { tone: "calme" })).out);
    expect(changed.thread).toBe(first.thread);
    expect(changed.text).toContain("calme");
    a.reset("s");
    expect(JSON.parse((await collect(a, "quatre", "s", options)).out).text).toContain("joueur");
  });

  it("réinitialise les préférences après un tour refusé par le CLI", async () => {
    const a = (await boot({ "brain.main": "x/codex" })).main()!.agent!;
    await expect(collect(a, "échec simulé", "s", { tone: "joueur" })).rejects.toThrow("échec simulé");
    expect(JSON.parse((await collect(a, "retour", "s", { tone: "joueur" })).out).text).toContain("joueur");
  });

  it("découvre Luna et les pages suivantes du catalogue, puis transmet le choix au cerveau", async () => {
    const b = await boot({ "brain.main": "x/codex", "brain.delegate": "x/codex" });
    const prov = b.k.items.provider("codex-cli")!;
    expect((await prov.action?.("codex", "refresh-models"))?.ok).toBe(true);
    for (const field of prov.kinds![0]!.fields) {
      expect(field.options).toContainEqual({ value: "gpt-6-luna", label: "GPT-6 Luna" });
      expect(field.options).toContainEqual({ value: "future-model", label: "Future model" });
      expect(field.options?.some((o) => o.value === "hidden-model")).toBe(false);
    }
    expect((await prov.update!("codex", { model: "gpt-6-luna", delegateModel: "future-model" })).ok).toBe(true);
    expect(JSON.parse((await collect(b.main()!.agent!, "bonjour")).out).model).toBe("gpt-6-luna");
    expect(b.dlg()!.name).toBe("codex:future-model");
  });

  it("outil MCP signalé ; demande d'accord du CLI refusée", async () => {
    const a = (await boot({ "brain.main": "x/codex" })).main()!.agent!;
    const r = await collect(a, "outil");
    expect(r.tools).toEqual(["agenda_du_jour"]);
    expect(r.out).toBe("decision:decline");
  });

  it("annulation : le tour en cours est interrompu", async () => {
    const a = (await boot({ "brain.main": "x/codex" })).main()!.agent!;
    const ac = new AbortController();
    let info: Record<string, unknown> = {};
    for await (const ev of a.run({ text: "lent", session: "s", mode: "text", signal: ac.signal })) {
      if (ev.type === "text") ac.abort(); // le tour a commencé : on l'arrête
      if (ev.type === "done") info = ev.info ?? {};
    }
    expect(info).toMatchObject({ turn_status: "interrupted" });
  });
});
