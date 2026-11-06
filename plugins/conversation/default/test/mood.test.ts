import { describe, it, expect } from "vitest";
import { MoodTracker, guessEmotion, ReplyFeeler, AFFECT } from "../src/index.ts";
import { EMOTIONS } from "@floppy/protocol";

describe("humeur", () => {
  it("toutes les émotions ont un effet sur l'humeur", () => {
    expect(EMOTIONS.filter((e) => !AFFECT[e])).toEqual([]);
  });

  it("les bonnes nouvelles rendent joyeux, les échecs penaud, puis elle revient vers la base", () => {
    let now = 0;
    const m = new MoodTracker({ now: () => now });
    const base = m.snapshot();
    for (let i = 0; i < 4; i++) m.feel("joy");
    expect(m.valence).toBeGreaterThan(base.valence + 0.3);
    for (let i = 0; i < 8; i++) m.feel("sorry");
    expect(m.valence).toBeLessThan(0);
    // Les émotions de situation (réfléchir, veille) ne changent rien.
    const v = m.valence;
    m.feel("thinking");
    expect(m.valence).toBe(v);
    now += 60 * 60_000; // une heure plus tard
    m.touch();
    expect(Math.abs(m.valence - base.valence)).toBeLessThan(0.05);
  });

  it("seul longtemps, il perd de l'énergie ; quand on lui parle, il se réveille un peu", () => {
    let now = 0;
    const m = new MoodTracker({ now: () => now });
    now += 30 * 60_000;
    m.tick();
    expect(m.energy).toBeLessThan(0.2);
    const tired = m.energy;
    m.touch();
    expect(m.energy).toBeGreaterThan(tired + 0.15);
  });

  it("n'envoie l'humeur que si elle change nettement", () => {
    const m = new MoodTracker({ now: () => 0 });
    expect(m.changed()).toBeDefined();
    expect(m.changed()).toBeUndefined();
    m.feel("laugh", 1.25);
    expect(m.changed()).toBeDefined();
  });
});

describe("émotion devinée dans le texte", () => {
  it("ce qu'on lui dit", () => {
    expect(guessEmotion("merci beaucoup", "user")?.emotion).toBe("happy");
    expect(guessEmotion("haha t'es drôle", "user")?.emotion).toBe("laugh");
    expect(guessEmotion("Bravo, bien joué !", "user")?.emotion).toBe("proud");
    expect(guessEmotion("je t'aime Floppy", "user")?.emotion).toBe("love");
    expect(guessEmotion("t'es nul", "user")?.emotion).toBe("sad");
    expect(guessEmotion("quelle heure est-il", "user")).toBeUndefined();
  });

  it("ce que dit le modèle Live, phrase par phrase", () => {
    const f = new ReplyFeeler();
    expect(f.push("Désolé, je n'ai pas")).toBeUndefined();
    expect(f.push(" trouvé. Mais")).toMatchObject({ emotion: "sorry" });
    expect(f.push(" c'est génial quand même ! Bon")).toMatchObject({ emotion: "joy" });
    expect(f.push(" voilà l'heure: 10 h")).toBeUndefined();
  });
});
