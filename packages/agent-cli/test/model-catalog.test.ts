import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@floppy/core";
import { createModelCatalog } from "../src/model-catalog.ts";

describe("catalogue dynamique des agents", () => {
  afterEach(() => vi.useRealTimers());
  const initial = [{ id: "default", label: "Default" }];
  const context = () => ({ alive: true, items: { changed: vi.fn() } }) as unknown as Context;

  it("charge en arrière-plan, partage les appels concurrents et garde un cache de cinq minutes", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const discover = vi.fn().mockResolvedValue([{ id: "future", label: "Future" }]);
    const catalog = createModelCatalog(ctx, initial, () => [], discover);
    catalog.touch(); catalog.touch();
    const a = catalog.refresh(), b = catalog.refresh();
    expect(a).toBe(b);
    expect(catalog.options).toEqual([{ value: "default", label: "Default" }]);
    expect((await a).ok).toBe(true);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(catalog.options).toContainEqual({ value: "future", label: "Future" });
    catalog.touch();
    expect(discover).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000);
    catalog.touch(); await catalog.refresh();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("conserve le choix enregistré, retire les modèles disparus non sélectionnés et garde la dernière liste en cas d'échec", async () => {
    const ctx = context();
    const selected = [{ id: "saved", label: "Saved" }];
    const discover = vi.fn().mockResolvedValueOnce([{ id: "old", label: "Old" }])
      .mockResolvedValueOnce([{ id: "new", label: "New" }]).mockRejectedValueOnce(new Error("hors ligne"));
    const catalog = createModelCatalog(ctx, initial, () => selected, discover);
    await catalog.refresh();
    await catalog.refresh();
    expect(catalog.find("saved")).toEqual(selected[0]);
    expect(catalog.find("old")).toBeUndefined();
    const before = [...catalog.options];
    expect((await catalog.refresh()).ok).toBe(false);
    expect(catalog.options).toEqual(before);
    expect(catalog.warning).toMatchObject({ fr: expect.any(String), en: expect.any(String) });
  });

  it("une erreur synchrone ou un catalogue vide reste réessayable ; un plugin arrêté ne publie rien", async () => {
    const ctx = context();
    const discover = vi.fn().mockImplementationOnce(() => { throw new Error("absent"); })
      .mockResolvedValueOnce([]).mockResolvedValue(initial);
    const catalog = createModelCatalog(ctx, initial, () => [], discover);
    expect((await catalog.refresh()).ok).toBe(false);
    expect((await catalog.refresh()).ok).toBe(false);
    expect((await catalog.refresh()).ok).toBe(true);
    expect(catalog.warning).toBeUndefined();
    (ctx as { alive: boolean }).alive = false;
    catalog.touch(); await catalog.refresh();
    expect(discover).toHaveBeenCalledTimes(3);
  });
});
