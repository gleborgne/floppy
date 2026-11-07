// Outils partagés des plugins : serveur local (llama-server, audio.cpp) et secret de chaque élément d'une liste.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, SECRET_SET, definePlugin, itemSecret, programBase, startLocalServer, tr, errorText, type Context } from "../src/index.ts";

async function plugin(): Promise<{ ctx: Context; k: Kernel }> {
  let ctx!: Context;
  const p = definePlugin({
    manifest: { id: "srv", version: "0", licence: "MIT", permissions: { exec: [programBase(process.execPath)] } },
    apply(c) { ctx = c; },
  });
  const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "floppy-srv-")), plugins: [p] });
  await k.applyConfig({ plugins: [{ id: "srv", plugin: "srv" }] });
  return { ctx, k };
}
const node = (code: string) => ({ exe: process.execPath, args: ["-e", code] });
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("serveur local", () => {
  it("prêt : rend l'arrêt ; l'arrêter n'est pas une panne", async () => {
    const { ctx, k } = await plugin();
    const crashes: string[] = [];
    const stop = await startLocalServer(ctx, { name: "srv", ...node("setTimeout(() => {}, 10000)"), base: "http://x", startTimeout_s: 5, onCrash: (w) => crashes.push(w), healthy: async () => true });
    expect(k.children.list()).toHaveLength(1);
    stop();
    await until(() => k.children.list().length === 0);
    expect(k.children.list()).toEqual([]);
    expect(crashes).toEqual([]);
    await k.stopAll();
  });

  it("s'arrête avant d'être prêt : l'erreur donne la fin de son journal", async () => {
    const { ctx, k } = await plugin();
    const err = await startLocalServer(ctx, { name: "srv", ...node("console.error('modèle introuvable'); process.exit(3)"), base: "http://x", startTimeout_s: 5, onCrash: () => {}, healthy: async () => false }).catch((e) => e);
    expect(tr(errorText(err), "fr")).toMatch(/srv n'a pas démarré : modèle introuvable/);
    await k.stopAll();
  });

  it("une fois prêt : arrêté seul ou figé, onCrash le dit et le programme est arrêté", async () => {
    const { ctx, k } = await plugin();
    const crashes: string[] = [];
    await startLocalServer(ctx, { name: "srv", ...node("setTimeout(() => process.exit(1), 100)"), base: "http://x", startTimeout_s: 5, onCrash: (w) => crashes.push(w), healthy: async () => true });
    await until(() => crashes.length > 0);
    expect(crashes[0]).toMatch(/srv s'est arrêté \(code 1\)/);

    const frozen: string[] = [];
    let ready = true;
    await startLocalServer(ctx, { name: "srv", ...node("setTimeout(() => {}, 10000)"), base: "http://x", startTimeout_s: 5, onCrash: (w) => frozen.push(w), healthEveryMs: 5,
      healthy: async () => { const r = ready; ready = false; return r; } });
    await until(() => frozen.length > 0);
    expect(frozen).toEqual(["srv ne répond plus (3 vérifications ratées)"]);
    await until(() => k.children.list().length === 0);
    expect(k.children.list()).toEqual([]);
    await k.stopAll();
  });
});

describe("secret d'un élément", () => {
  it("formulaire : SECRET_SET ou rien = inchangé, vide = effacé ; le test prend la valeur tapée, sinon celle du coffre", () => {
    const secrets = new MemorySecrets();
    const s = itemSecret({ secrets }, (id) => `p/${id}/key`);
    expect(s.shown("a")).toBe("");
    s.apply("a", "  sk-1 ");
    expect(secrets.get("p/a/key")).toBe("sk-1");
    expect(s.shown("a")).toBe(SECRET_SET);
    s.apply("a", SECRET_SET);
    s.apply("a", undefined);
    expect(s.get("a")).toBe("sk-1");
    expect(s.typedOr("a", SECRET_SET)).toBe("sk-1");
    expect(s.typedOr("a", "sk-2")).toBe("sk-2");
    expect(s.typedOr(undefined, SECRET_SET)).toBeUndefined();
    s.apply("a", "");
    expect(s.has("a")).toBe(false);
    s.apply("b", "x");
    s.remove("b");
    expect(s.has("b")).toBe(false);
  });
});
