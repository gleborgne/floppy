import { describe, it, expect } from "vitest";
import { OsSecrets } from "../src/secrets.ts";

// Vrai trousseau de l'OS (Gestionnaire d'identification Windows) : un secret long (jeton Microsoft) passe en morceaux.
describe.runIf(process.platform === "win32")("trousseau de l'OS", () => {
  it("secret long (au-delà de la limite de 2560 octets) : écrit, relu, effacé", () => {
    const s = new OsSecrets("floppy-test");
    const long = "x".repeat(4321) + "fin";
    s.set("long", long);
    expect(s.get("long")).toBe(long);
    s.set("long", "court");
    expect(s.get("long")).toBe("court");
    s.set("long", long);
    s.delete("long");
    expect(s.get("long")).toBeUndefined();
    expect(s.get("long#0")).toBeUndefined();
  });
});
