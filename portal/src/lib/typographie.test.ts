import { createTranslator } from "next-intl";
import { describe, expect, test } from "vitest";
import { espacesInsecables, typographieFrancaise } from "./typographie";

const INSECABLE = " ";

describe("espacesInsecables", () => {
  test("l'espace avant ; : ! ? devient insécable : aucune ligne ne commence par l'un de ces signes", () => {
    expect(espacesInsecables("sous-traitance ; à terme")).toBe(`sous-traitance${INSECABLE}; à terme`);
    expect(espacesInsecables("Notre choix pour : {cas}")).toBe(`Notre choix pour${INSECABLE}: {cas}`);
    expect(espacesInsecables("Vraiment ? Oui !")).toBe(`Vraiment${INSECABLE}? Oui${INSECABLE}!`);
  });

  test("les guillemets français restent collés au texte qu'ils encadrent", () => {
    expect(espacesInsecables("le bouton « Voir la fiche détaillée »")).toBe(`le bouton «${INSECABLE}Voir la fiche détaillée${INSECABLE}»`);
  });

  test("les adresses, les heures et la syntaxe des messages sont inchangées", () => {
    for (const texte of ["https://ai-api.linagora.com/v1", "à 7:00", "{nombre, plural, one {# clé} other {# clés}}", "Lien: {url}"]) {
      expect(espacesInsecables(texte)).toBe(texte);
    }
  });

  test("un format de nombre ICU (::currency/EUR) reste lisible par next-intl : le montant garde sa devise", () => {
    const message = "{montant, number, ::currency/EUR} par période : {periode}";
    const t = createTranslator({ locale: "fr", messages: { budget: espacesInsecables(message) } });
    expect(t("budget", { montant: 50, periode: "30 jours" })).toMatch(/^50,00\s€ par période\u00a0: 30 jours$/);
  });
});

describe("typographieFrancaise", () => {
  test("s'applique à tous les textes d'un dictionnaire, listes comprises", () => {
    expect(typographieFrancaise({ a: "Jamais : rien", b: { c: ["Oui ?", "Non"] } })).toEqual({
      a: `Jamais${INSECABLE}: rien`,
      b: { c: [`Oui${INSECABLE}?`, "Non"] },
    });
  });
});
