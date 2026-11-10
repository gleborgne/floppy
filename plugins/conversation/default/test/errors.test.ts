import { describe, it, expect } from "vitest";
import { tr } from "@floppy/core";
import { NoBrainError, classifyTurnError, errorPhrase, isNetworkError } from "../src/errors.ts";
import { PHRASES } from "../src/model.ts";

describe("cause d'un tour en échec", () => {
  it("aucun cerveau actif", () => { expect(classifyTurnError(new NoBrainError(), false)).toBe("no_brain"); });
  it("silence trop long du cerveau", () => { expect(classifyTurnError(new Error("le cerveau ne répond plus depuis 300 s"), true)).toBe("stalled"); });
  it("erreur réseau : fetch échoué, connexion refusée (même en cause), délai", () => {
    expect(classifyTurnError(new TypeError("fetch failed"), false)).toBe("network");
    expect(classifyTurnError(new Error("x", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }), false)).toBe("network");
    expect(classifyTurnError(Object.assign(new Error("délai"), { name: "TimeoutError" }), false)).toBe("network");
    expect(classifyTurnError(new Error("getaddrinfo ENOTFOUND api.contoso.test"), false)).toBe("network");
    expect(isNetworkError("socket hang up")).toBe(true);
  });
  it("autre erreur", () => { expect(classifyTurnError(new Error("JSON illisible"), false)).toBe("other"); });
  it("chaque cas a sa phrase, dans les deux langues ; error_reply ne remplace que « autre »", () => {
    for (const lang of ["fr", "en"] as const) {
      const set = new Set((["no_brain", "stalled", "network"] as const).map((k) => errorPhrase(k, lang, "perso")));
      expect(set.size).toBe(3);
      expect(set.has("perso")).toBe(false);
      expect(errorPhrase("other", lang, "perso")).toBe("perso");
    }
    expect(errorPhrase("network", "en", "x")).toBe(tr(PHRASES.error_network, "en"));
    expect(errorPhrase("stalled", "fr", "x")).toBe(tr(PHRASES.error_stalled, "fr"));
  });
});
