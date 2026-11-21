import { expect, test } from "vitest";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { API_KINDS } from "./client";

/** Types d'API sans texte parmi les entrées d'un dictionnaire. */
const sansTexte = (entrees: Record<string, string>, types: readonly string[]) => types.filter((type) => !entrees[type]?.trim());

test.each([
  ["français", fr],
  ["anglais", en],
])("en %s, chaque type d'API a son nom, au catalogue et dans la supervision, et sa raison d'être écarté des assistants de code (ticket #214)", (_, messages) => {
  expect(sansTexte(messages.domaine.typesApi, API_KINDS), "catalogue").toEqual([]);
  expect(sansTexte(messages.gestion.supervision.typesApi, API_KINDS), "supervision").toEqual([]);
  // Seuls les modèles de conversation entrent dans les configurations d'OpenCode et de Claude Code.
  expect(sansTexte(messages.assistants.raisonsModele, API_KINDS.filter((type) => type !== "conversation")), "assistants de code").toEqual([]);
});

/** Types d'API sans section dans la fiche d'un modèle : un titre et une explication. */
const sansSection = (sections: Record<string, { titre: string; explication: string }>, types: readonly string[]) =>
  types.filter((type) => !sections[type]?.titre?.trim() || !sections[type]?.explication?.trim());

test.each([
  ["français", fr],
  ["anglais", en],
])("en %s, la fiche d'un modèle présente chaque type d'API autre que la conversation, avec un titre et une explication (ticket #217)", (_, messages) => {
  expect(sansSection(messages.detail.typesApi, API_KINDS.filter((type) => type !== "conversation"))).toEqual([]);
});
