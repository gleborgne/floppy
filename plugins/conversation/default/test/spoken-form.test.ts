// Forme parlée : heures, adresses, chemins, identifiants, symboles ; le texte ordinaire ne bouge pas.
import { describe, expect, it } from "vitest";
import { spokenForm } from "../src/spoken-form.ts";

describe("spokenForm : heures", () => {
  it("français : « 14:30 » → « 14 h 30 », « 9:00 » → « 9 h »", () => {
    expect(spokenForm("Rendez-vous à 14:30.", "fr")).toBe("Rendez-vous à 14 h 30.");
    expect(spokenForm("Réveil à 9:00 demain", "fr")).toBe("Réveil à 9 h demain");
    expect(spokenForm("À 9:05 et 23:59", "fr")).toBe("À 9 h 05 et 23 h 59");
    expect(spokenForm("Il est 2:30 PM", "fr")).toBe("Il est 14 h 30");
  });
  it("anglais : 12 heures avec AM / PM", () => {
    expect(spokenForm("Meet at 14:30.", "en")).toBe("Meet at 2:30 PM.");
    expect(spokenForm("Alarm at 9:00 tomorrow", "en")).toBe("Alarm at 9 AM tomorrow");
    expect(spokenForm("At 2:30 PM sharp", "en")).toBe("At 2:30 PM sharp");
    expect(spokenForm("At 0:15 and 12:00", "en")).toBe("At 12:15 AM and 12 PM");
  });
  it("ce qui n'est pas une heure plausible reste tel quel", () => {
    expect(spokenForm("Format 16:9 ou 4:3", "fr")).toBe("Format 16:9 ou 4:3");
    expect(spokenForm("Score 25:30 puis 14:75", "fr")).toBe("Score 25:30 puis 14:75");
    expect(spokenForm("Durée 1:30:45", "fr")).toBe("Durée 1:30:45");
  });
});

describe("spokenForm : adresses, chemins, identifiants", () => {
  it("une adresse web devient « un lien vers <domaine> »", () => {
    expect(spokenForm("Voir https://www.contoso.com/docs/page?id=3 pour le détail.", "fr")).toBe("Voir un lien vers contoso.com pour le détail.");
    expect(spokenForm("See (https://docs.contoso.com/a/b).", "en")).toBe("See (a link to docs.contoso.com).");
  });
  it("une adresse mail reste telle quelle", () => {
    expect(spokenForm("Écris à alice@contoso.com demain.", "fr")).toBe("Écris à alice@contoso.com demain.");
  });
  it("chemin long : un fichier et son nom", () => {
    expect(spokenForm("Ouvre C:\\Users\\alice\\Notes\\rapport.docx maintenant", "fr")).toBe("Ouvre un fichier rapport.docx maintenant");
    expect(spokenForm("Open ~/Notes/2026/plan.md now.", "en")).toBe("Open a file plan.md now.");
    expect(spokenForm("Voir /var/log/app/ pour les traces", "fr")).toBe("Voir un dossier app pour les traces");
  });
  it("les dates et alternatives avec barre oblique ne sont pas des chemins", () => {
    expect(spokenForm("Le 10/11/2026, oui/non, 24/7 et km/h.", "fr")).toBe("Le 10/11/2026, oui/non, 24/7 et km/h.");
  });
  it("UUID et identifiants hexadécimaux longs : « un identifiant »", () => {
    expect(spokenForm("Tâche 123e4567-e89b-12d3-a456-426614174000 terminée", "fr")).toBe("Tâche un identifiant terminée");
    expect(spokenForm("Commit 9fceb02d0ae598e95dc970b74767f19372d61af8 pushed", "en")).toBe("Commit an identifier pushed");
    expect(spokenForm("Le mot decaffeinated et le nombre 12345678901234567", "fr")).toBe("Le mot decaffeinated et le nombre 12345678901234567");
  });
});

describe("spokenForm : symboles", () => {
  it("pour cent, euros, et, vers", () => {
    expect(spokenForm("Remise de 20% et 5,5 %.", "fr")).toBe("Remise de 20 pour cent et 5,5 pour cent.");
    expect(spokenForm("A 20% discount", "en")).toBe("A 20 percent discount");
    expect(spokenForm("Ça coûte 5 € ou 1 € ou 1 200 €.", "fr")).toBe("Ça coûte 5 euros ou 1 euro ou 1 200 euros.");
    expect(spokenForm("Rien que € seul", "fr")).toBe("Rien que € seul");
    expect(spokenForm("Pain & lait", "fr")).toBe("Pain et lait");
    expect(spokenForm("Bread & milk, AT&T", "en")).toBe("Bread and milk, AT&T");
    expect(spokenForm("Paris → Lyon", "fr")).toBe("Paris vers Lyon");
    expect(spokenForm("Paris → Lyon", "en")).toBe("Paris to Lyon");
  });
});

describe("spokenForm : texte ordinaire", () => {
  it("reste strictement identique", () => {
    for (const t of [
      "Bonjour, je suis là pour t'aider.",
      "Il fait beau à Genève, très chaud en été : prends un chapeau !",
      "Où est l'éléphant ? Ça m'étonne, vraiment… Naïveté et œuvres.",
      "I'll see you tomorrow, it's fine. Thank you!",
      "Le 3 mai 2026, 12 personnes, 1,5 kg, 3.14 environ.",
      "  Espaces   multiples\net retour à la ligne.  ",
      "",
    ]) {
      expect(spokenForm(t, "fr")).toBe(t);
      expect(spokenForm(t, "en")).toBe(t);
    }
  });
});
