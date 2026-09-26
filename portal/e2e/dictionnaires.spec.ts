import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/* Les dictionnaires français et anglais ont exactement les mêmes entrées, toutes renseignées. */
type Arbre = { [cle: string]: string | Arbre };

function entrees(arbre: Arbre, prefixe = ""): Map<string, string> {
  const resultat = new Map<string, string>();
  for (const [cle, valeur] of Object.entries(arbre)) {
    const chemin = prefixe ? `${prefixe}.${cle}` : cle;
    if (typeof valeur === "string") resultat.set(chemin, valeur);
    else for (const [c, v] of entrees(valeur, chemin)) resultat.set(c, v);
  }
  return resultat;
}

const lire = (langue: string) => entrees(JSON.parse(readFileSync(`messages/${langue}.json`, "utf8")) as Arbre);

test("les dictionnaires français et anglais ont les mêmes entrées, toutes renseignées", () => {
  const [fr, en] = [lire("fr"), lire("en")];
  expect([...fr.keys()].filter((c) => !en.has(c)), "entrées absentes du dictionnaire anglais").toEqual([]);
  expect([...en.keys()].filter((c) => !fr.has(c)), "entrées absentes du dictionnaire français").toEqual([]);
  expect([...fr, ...en].filter(([, v]) => !v.trim()).map(([c]) => c), "entrées vides").toEqual([]);
});

test("la marque s'écrit toujours LINAGORA, en majuscules, dans les deux dictionnaires", () => {
  // Hors adresses (linagora.com, @linagora) et identifiants (LINAGORA_API_KEY).
  const marque = /(?<![@./\w])linagora(?![.\w])/gi;
  const [fr, en] = [lire("fr"), lire("en")];
  const fautives = [...fr, ...en].filter(([, v]) => (v.match(marque) ?? []).some((m) => m !== "LINAGORA")).map(([c]) => c);
  expect(fautives, "entrées où la marque n'est pas en majuscules").toEqual([]);
});

test("l'unité des prix ne se coupe pas : « par million de jetons » passe à la ligne d'un bloc", () => {
  const [fr, en] = [lire("fr"), lire("en")];
  const coupables = [...fr, ...en].filter(([, v]) => /par million de jetons|per million tokens/.test(v)).map(([c]) => c);
  expect(coupables, "entrées où l'unité peut se couper (espaces ordinaires)").toEqual([]);
});
