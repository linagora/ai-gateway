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
});

describe("typographieFrancaise", () => {
  test("s'applique à tous les textes d'un dictionnaire, listes comprises", () => {
    expect(typographieFrancaise({ a: "Jamais : rien", b: { c: ["Oui ?", "Non"] } })).toEqual({
      a: `Jamais${INSECABLE}: rien`,
      b: { c: [`Oui${INSECABLE}?`, "Non"] },
    });
  });
});
