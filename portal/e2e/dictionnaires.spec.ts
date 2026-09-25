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
