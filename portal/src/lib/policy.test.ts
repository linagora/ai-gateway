import { describe, expect, test } from "vitest";
import { canAccessRequest, type CatalogModel, checkKeyRequest, checkTransition, isAdmin, type KeyRequestDraft, modelAcceptsLevel, type TeamForPolicy } from "./policy";

describe("canAccessRequest", () => {
  const demande = { requesterUid: "mmaudet" };

  test("le demandeur accède à sa demande", () => {
    expect(canAccessRequest({ uid: "mmaudet", isAdmin: false }, demande)).toBe(true);
  });

  test("un autre utilisateur n'accède pas à la demande", () => {
    expect(canAccessRequest({ uid: "pmartin", isAdmin: false }, demande)).toBe(false);
  });

  test("un admin accède à toutes les demandes", () => {
    expect(canAccessRequest({ uid: "jdupont", isAdmin: true }, demande)).toBe(true);
  });
});

describe("checkTransition", () => {
  test("une demande soumise peut être approuvée", () => {
    expect(checkTransition("SOUMISE", "APPROUVEE")).toEqual({ ok: true });
  });

  test("une demande approuvée ne peut pas redevenir soumise", () => {
    expect(checkTransition("APPROUVEE", "SOUMISE")).toEqual({ ok: false, reason: "transition_interdite" });
  });

  test("une demande approuvée dont la clé n'est pas retirée peut être annulée (sortie d'une équipe, F-54)", () => {
    expect(checkTransition("APPROUVEE", "ANNULEE")).toEqual({ ok: true });
  });

  test("une clé révoquée est un état final", () => {
    expect(checkTransition("REVOQUEE", "CLE_EMISE")).toEqual({ ok: false, reason: "transition_interdite" });
  });

  test("un refus sans motif est rejeté", () => {
    expect(checkTransition("SOUMISE", "REFUSEE", { comment: "  " })).toEqual({ ok: false, reason: "motif_obligatoire" });
  });

  test("un refus motivé est accepté", () => {
    expect(checkTransition("SOUMISE", "REFUSEE", { comment: "Projet sans budget validé" })).toEqual({ ok: true });
  });
});

const catalog: CatalogModel[] = [
  { modelName: "gpt-oss-120b", dataLevel: "N1", visible: true },
  { modelName: "mistral-small", dataLevel: "N2", visible: true },
  { modelName: "qwen3.8", dataLevel: "N3", visible: true },
  { modelName: "modele-en-test", dataLevel: "N3", visible: false },
  { modelName: "modele-beta", dataLevel: "EXP", visible: true },
];

const team: TeamForPolicy = {
  teamId: "equipe-rd",
  models: ["gpt-oss-120b", "mistral-small", "qwen3.8", "modele-en-test", "modele-beta"],
  memberUids: ["mmaudet", "jdupont"],
};

const draft: KeyRequestDraft = { requesterUid: "mmaudet", teamId: "equipe-rd", dataLevel: "N2", models: ["mistral-small", "qwen3.8"] };

const failedChecks = (d: KeyRequestDraft) =>
  checkKeyRequest(d, team, catalog).checks.filter((c) => !c.ok).map((c) => ({ id: c.id, offending: c.offending }));

describe("checkKeyRequest", () => {
  test("une demande conforme passe tous les contrôles", () => {
    expect(checkKeyRequest(draft, team, catalog).ok).toBe(true);
  });

  test("un demandeur qui n'est pas membre de l'équipe est refusé", () => {
    expect(failedChecks({ ...draft, requesterUid: "pmartin" })).toEqual([{ id: "membre_equipe", offending: ["pmartin"] }]);
  });

  test("un modèle non autorisé pour l'équipe est refusé", () => {
    const equipeRestreinte = { ...team, models: ["mistral-small"] };
    const verdict = checkKeyRequest(draft, equipeRestreinte, catalog);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([{ id: "modeles_equipe", ok: false, offending: ["qwen3.8"] }]);
  });

  test("critère 5 : une demande N3 incluant des modèles N1 ou N2 est refusée", () => {
    const demandeN3 = { ...draft, dataLevel: "N3" as const, models: ["gpt-oss-120b", "mistral-small", "qwen3.8"] };
    expect(failedChecks(demandeN3)).toEqual([{ id: "niveau_modeles", offending: ["gpt-oss-120b", "mistral-small"] }]);
  });

  test("une demande Expérimental portant sur un modèle expérimental passe tous les contrôles", () => {
    expect(checkKeyRequest({ ...draft, dataLevel: "EXP", models: ["modele-beta"] }, team, catalog).ok).toBe(true);
  });

  test("une clé Expérimental ne contient que des modèles expérimentaux", () => {
    const demande = { ...draft, dataLevel: "EXP" as const, models: ["modele-beta", "gpt-oss-120b", "qwen3.8"] };
    expect(failedChecks(demande)).toEqual([{ id: "niveau_modeles", offending: ["gpt-oss-120b", "qwen3.8"] }]);
  });

  test("un modèle expérimental n'entre pas dans une clé N1, même pour des données publiques", () => {
    const demande = { ...draft, dataLevel: "N1" as const, models: ["gpt-oss-120b", "modele-beta"] };
    expect(failedChecks(demande)).toEqual([{ id: "niveau_modeles", offending: ["modele-beta"] }]);
  });

  test("un modèle masqué ou absent du catalogue est refusé", () => {
    const equipe = { ...team, models: [...team.models, "modele-inconnu"] };
    const demande = { ...draft, models: ["mistral-small", "modele-en-test", "modele-inconnu"] };
    const verdict = checkKeyRequest(demande, equipe, catalog);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([
      { id: "modeles_visibles", ok: false, offending: ["modele-en-test", "modele-inconnu"] },
    ]);
  });

  test("une équipe sans liste de modèles les autorise tous, comme dans LiteLLM", () => {
    expect(checkKeyRequest(draft, { ...team, models: [] }, catalog).ok).toBe(true);
  });

  test("la valeur all-proxy-models de LiteLLM autorise tous les modèles", () => {
    expect(checkKeyRequest(draft, { ...team, models: ["all-proxy-models"] }, catalog).ok).toBe(true);
  });

  test("une demande sans modèle est refusée", () => {
    expect(failedChecks({ ...draft, models: [] })).toEqual([{ id: "modeles_presents", offending: [] }]);
  });
});

describe("isAdmin", () => {
  test("un uid présent dans la liste des admins est admin", () => {
    expect(isAdmin("mmaudet", ["jdupont", "mmaudet"])).toBe(true);
  });

  test("un uid absent de la liste n'est pas admin", () => {
    expect(isAdmin("pmartin", ["jdupont", "mmaudet"])).toBe(false);
  });
});

describe("modelAcceptsLevel", () => {
  test("un modèle N3 accepte des données N2", () => {
    expect(modelAcceptsLevel("N3", "N2")).toBe(true);
  });

  test("un modèle N1 refuse des données N2", () => {
    expect(modelAcceptsLevel("N1", "N2")).toBe(false);
  });

  test("un modèle accepte des données de son propre niveau", () => {
    expect(modelAcceptsLevel("N2", "N2")).toBe(true);
  });
});
