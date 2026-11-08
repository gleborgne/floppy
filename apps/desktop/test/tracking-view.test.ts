// @vitest-environment happy-dom
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentTrackingSnapshot } from "@floppy/contracts";
import { startTracking } from "../src/renderer/tracking-view.ts";

expectTypeOf<TrackingSnapshot>().toEqualTypeOf<AgentTrackingSnapshot>();
expectTypeOf<Window["floppyDesktop"]>().toEqualTypeOf<FloppyDesktopApi | undefined>();
let stop = () => {};
afterEach(() => { stop(); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const now = Date.now();
  const root = document.createElement("main"); document.body.append(root);
  let update!: (p: TrackingPayload) => void;
  const unsubscribe = vi.fn(), refresh = vi.fn(async () => ({ ok: true }));
  const api = { get: vi.fn(async () => null), refresh, onUpdate: (fn: typeof update) => { update = fn; return unsubscribe; } };
  const row = (id: string, label: string, project: string, extra: Partial<TrackingRecord> = {}): TrackingRecord => ({ id, label, project, activity: "working", outcome: "unknown", presence: "live", observedAt: now, lastSeenAt: now, ...extra });
  const snapshot: TrackingSnapshot = { at: now, connection: { state: "connected", coverage: "partial", lastSyncAt: now }, agents: [
    row("a", "Camille", "Contoso", { mission: "Corriger la recherche", progress: "Tests en cours", details: "Trois fichiers modifiés" }),
    row("b", "Robin", "Fabrikam", { activity: "waiting", waitingReason: "Choix de la branche", presence: "unknown" }),
    row("c", "Alex", "Contoso", { activity: "finished", outcome: "success", declaredResult: "Tests verts" }),
  ], events: [{ eventId: "event-1", agentId: "a", at: now, kind: "progress", summary: "Ajout du filtre" }] };
  stop = startTracking(root, api);
  update({ snapshot, lang: "fr" });
  return { root, snapshot, update, api, unsubscribe, rows: () => [...root.querySelectorAll<HTMLButtonElement>(".agent-row")], detail: () => root.querySelector("#agent-detail")!, search: () => root.querySelector<HTMLInputElement>("input")! };
}

it("montre chaque agent nommé par groupe et inspecte tous ses faits sans commander d'agent", async () => {
  const f = fixture();
  expect(f.rows().map((el) => el.textContent)).toEqual([expect.stringContaining("Robin"), expect.stringContaining("Camille"), expect.stringContaining("Alex")]);
  expect(f.root.textContent).toContain("Couverture partielle"); expect(f.root.textContent).toContain("Terminé récemment");
  f.rows()[1]!.click();
  expect(f.detail().textContent).toMatch(/Camille.*Corriger la recherche.*Trois fichiers modifiés.*Tests en cours/s);
  expect(f.detail().textContent).toContain("Ajout du filtre"); expect(f.detail().textContent).toContain("Non renseigné par la source");
  expect(f.api.refresh).not.toHaveBeenCalled();
  const chosen = f.rows()[1]!; chosen.focus();
  f.snapshot.agents[0]!.progress = "Vérification terminée";
  f.update({ snapshot: f.snapshot, lang: "fr" });
  expect(f.rows()[1]).toBe(chosen); expect(document.activeElement).toBe(chosen);
  expect(chosen.getAttribute("aria-expanded")).toBe("true"); expect(f.detail().textContent).toContain("Vérification terminée");
  f.snapshot.agents[0]!.activity = "waiting";
  f.update({ snapshot: f.snapshot, lang: "fr" });
  expect(document.activeElement?.textContent).toContain("Camille");
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  f.snapshot.agents = f.snapshot.agents.slice(1); f.update({ snapshot: f.snapshot, lang: "fr" });
  expect(f.detail().textContent).toContain("n'est plus dans la source");
  await flush();
});

it("filtre projet/nom, garde le champ et la sélection, traduit les états et gère le clavier", () => {
  const f = fixture();
  f.rows()[0]!.focus(); f.rows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(f.rows()[1]);
  f.rows()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); expect(document.activeElement).toBe(f.rows()[2]);
  f.rows()[0]!.click(); expect(f.detail().textContent).toContain("Choix de la branche");
  const input = f.search(); input.value = "Contoso"; input.focus(); input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.rows()).toHaveLength(2); expect(f.search()).toBe(input); expect(document.activeElement).toBe(input);
  f.update({ snapshot: f.snapshot, lang: "en" });
  expect(document.documentElement.lang).toBe("en"); expect(f.root.textContent).toContain("Partial coverage");
  expect(f.detail().textContent).toContain("Waiting reason"); expect(f.search().value).toBe("Contoso");
  input.value = "unknown label"; input.dispatchEvent(new Event("input", { bubbles: true })); expect(f.root.textContent).toContain("No agents match");
});

it("expose les données anciennes/hors ligne et les erreurs, nettoie les abonnements et masque les chemins", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.snapshot.connection = { state: "connected", coverage: "partial", lastSyncAt: Date.now() - 180_000 };
  f.snapshot.agents[0]!.observedAt = Date.now() - 180_000;
  f.snapshot.agents[0]!.details = "Voir C:/private/secret.txt et /home/user/repo";
  f.update({ snapshot: f.snapshot, lang: "en" }); expect(f.root.textContent).toContain("Stale data"); expect(f.root.textContent).toContain("Old observation");
  f.rows().find((el) => el.textContent?.includes("Camille"))!.click(); expect(f.detail().textContent).not.toMatch(/private|secret.txt|home\/user/);
  f.api.refresh.mockRejectedValueOnce(new Error("provider secret"));
  f.root.querySelector<HTMLButtonElement>(".refresh")!.click(); await flush();
  expect(f.root.querySelector('[role="alert"]')?.textContent).toContain("Refresh failed");
  expect(f.root.textContent).not.toContain("provider secret");
  f.snapshot.connection = { state: "offline", coverage: "outage" }; f.update({ snapshot: f.snapshot, lang: "en" });
  expect(f.root.textContent).toContain("Offline"); expect(f.rows()).toHaveLength(3);
  stop(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  stop = () => {};
});

it("donne un état vide utile quand le fournisseur n'a aucun agent", () => {
  const f = fixture(); f.snapshot.agents = []; f.snapshot.connection = { state: "unknown", coverage: "unknown" };
  f.update({ snapshot: f.snapshot, lang: "en" });
  expect(f.root.textContent).toContain("No known named agents"); expect(f.root.textContent).toContain("Enable a tracking provider");
  expect(f.root.textContent).toContain("Unknown coverage");
});

it("le filtre de projet distingue les homonymes et ferme le détail vers la bonne ligne", () => {
  const f = fixture(); f.snapshot.agents[1]!.label = "Camille";
  f.update({ snapshot: f.snapshot, lang: "fr" });
  const select = f.root.querySelector<HTMLSelectElement>("select")!;
  select.value = "Fabrikam"; select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(f.rows()).toHaveLength(1); expect(f.rows()[0]?.textContent).toContain("Fabrikam");
  f.rows()[0]!.click();
  f.detail().querySelector<HTMLButtonElement>("button")!.click();
  expect(document.activeElement).toBe(f.rows()[0]);
});
