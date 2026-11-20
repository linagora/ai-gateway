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
