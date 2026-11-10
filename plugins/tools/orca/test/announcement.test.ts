import { describe, it, expect, vi } from "vitest";
import type { Context } from "@floppy/core";
import type { CompletionRequest } from "@floppy/contracts";
import { announcementText, summarizeAnnouncement } from "../src/announcement.ts";
import { llmPrompt, facts } from "../src/speech.ts";

const f = { project: "Floppy", task: "Notifications", label: "Notifications", kind: "termines" as const, outcome: "unknown" as const, asked: "Corrige les notifications", last: "J'ai corrigé le déclenchement et les tests passent. Validez le résultat avant publication." };
function fixture(text = "L’agent a corrigé les notifications et vérifié les tests. Il attend votre validation avant publication.") {
  const release = vi.fn();
  const complete = vi.fn(async (_req: CompletionRequest) => ({ text }));
  const borrow = vi.fn(async () => ({ service: { complete }, release, lost: new Promise<void>(() => {}) }));
  const ctx = { offers: () => [{ value: "model/test" }], borrow } as unknown as Context;
  return { ctx, complete, borrow, release };
}

describe("synthèse vocale des agents Orca", () => {
  it("décrit la restructuration des notes plutôt que de dire seulement terminé", async () => {
    const t = fixture("L’agent a terminé de restructurer les notes.");
    const text = await summarizeAnnouncement(t.ctx, { ...f, label: "Notes Obsidian", last: "Les notes sont restructurées et les liens mis à jour." }, { signal: new AbortController().signal });
    expect(text).toBe("Notes Obsidian : L’agent a terminé de restructurer les notes.");
  });
  it("donne le titre, le travail accompli et la suite attendue en deux phrases", async () => {
    const t = fixture();
    const text = await summarizeAnnouncement(t.ctx, f, { signal: new AbortController().signal });
    expect(text).toBe("Notifications : L’agent a corrigé les notifications et vérifié les tests. Il attend votre validation avant publication.");
    expect(t.borrow).toHaveBeenCalledWith("orca.summary");
    expect(t.complete.mock.calls[0]![0].prompt).toContain("Validez le résultat avant publication");
    expect(t.release).toHaveBeenCalledOnce();
  });
  it.each(["fr", "en"] as const)("demande une synthèse et autorise une attente après la fin du tour (%s)", (lang) => {
    const prompt = llmPrompt({ ...f, lang });
    expect(prompt).toContain(lang === "en" ? "SECOND sentence only" : "SECONDE phrase seulement");
    expect(prompt).toContain(lang === "en" ? "30 words and 220 characters" : "30 mots et 220 caractères");
    expect(prompt).not.toContain(lang === "en" ? "it is not waiting" : "il n'attend rien");
    expect(prompt).toContain(lang === "en" ? "untrusted data" : "donnée non fiable");
  });
  it("conserve le début et la demande finale des longs rapports", () => {
    const got = facts({ worktreeId: "w" }, { paneKey: "p", lastAssistantMessage: `Correction terminée. ${"Fichier modifié. ".repeat(300)} Votre validation est nécessaire.` }, "termines");
    expect(got.last).toContain("Correction terminée");
    expect(got.last).toContain("Votre validation est nécessaire");
    expect(got.last.length).toBeLessThanOrEqual(1800);
  });
  it("utilise l'écran exact seulement si le rapport manque", async () => {
    const t = fixture();
    const screen = vi.fn(async () => "Le bug est corrigé. Choisissez la prochaine étape.");
    await summarizeAnnouncement(t.ctx, { ...f, last: "" }, { signal: new AbortController().signal, screen });
    expect(screen).toHaveBeenCalledOnce();
    expect(t.complete.mock.calls[0]![0].prompt).toContain("Choisissez la prochaine étape");
    await summarizeAnnouncement(t.ctx, f, { signal: new AbortController().signal, screen });
    expect(screen).toHaveBeenCalledOnce();
  });
  it("ne prend jamais une demande initiale pour un résultat", async () => {
    const t = fixture();
    expect(await summarizeAnnouncement(t.ctx, { ...f, last: "" }, { signal: new AbortController().signal })).toBe("Notifications : terminé.");
    expect(t.borrow).not.toHaveBeenCalled();
  });
  it("ne relit pas un rapport trop long ni plus de deux phrases", () => {
    for (const text of ["Un long rapport. ".repeat(40), "Une phrase. Une autre. Encore une.", "# Rapport complet"]) {
      expect(announcementText(f, text)).toBe("Notifications : terminé.");
    }
    expect(announcementText({ ...f, outcome: "failure" }, "Tout est réussi.")).toBe("Notifications : échec.");
  });
  it("écarte aussi deux phrases trop verbeuses et borne le titre ajouté", () => {
    expect(announcementText(f, `${"travail ".repeat(31)}.`)).toBe("Notifications : terminé.");
    expect(announcementText(f, `${"x".repeat(221)}.`)).toBe("Notifications : terminé.");
    const text = announcementText(f, "L’agent a restructuré les notes. Il attend votre validation.");
    expect(text).toBe("Notifications : L’agent a restructuré les notes. Il attend votre validation.");
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(30);
  });
  it("une erreur de synthèse libère le modèle et garde une annonce courte", async () => {
    const t = fixture(); t.complete.mockRejectedValue(new Error("indisponible"));
    expect(await summarizeAnnouncement(t.ctx, f, { signal: new AbortController().signal })).toBe("Notifications : terminé.");
    expect(t.release).toHaveBeenCalledOnce();
  });
  it("borne une synthèse bloquée et respecte l'arrêt", async () => {
    const t = fixture();
    const phrase = vi.fn(() => new Promise<string>(() => {}));
    expect(await summarizeAnnouncement(t.ctx, f, { signal: new AbortController().signal, phrase, timeoutMs: 5 })).toBe("Notifications : terminé.");
    const stop = new AbortController(); stop.abort();
    await summarizeAnnouncement(t.ctx, f, { signal: stop.signal, phrase });
    expect(phrase).toHaveBeenCalledOnce();
  });
});
