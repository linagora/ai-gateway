import { describe, expect, test } from "vitest";
import {
  attendLActeur,
  attendUnResponsable,
  canAccessRequest,
  type CatalogModel,
  checkKeyRequest,
  checkTransition,
  decisionProposee,
  empechementDeDecider,
  enAttenteDeValidation,
  isAdmin,
  type KeyRequestDraft,
  modelAcceptsLevel,
  pasEncoreDecidee,
  type RequestStatus,
  STATUTS_EN_ATTENTE_DE_VALIDATION,
  STATUTS_PAS_ENCORE_DECIDES,
  statutApresComplement,
  type TeamForPolicy,
} from "./policy";

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

  test("une demande d'abonnement soumise reçoit l'accord du responsable, puis un admin l'approuve (spécification #93)", () => {
    expect(checkTransition("SOUMISE", "ACCORD_RESPONSABLE")).toEqual({ ok: true });
    expect(checkTransition("ACCORD_RESPONSABLE", "APPROUVEE")).toEqual({ ok: true });
  });

  test("l'accord du responsable ne se retire pas : la demande ne redevient pas soumise", () => {
    expect(checkTransition("ACCORD_RESPONSABLE", "SOUMISE")).toEqual({ ok: false, reason: "transition_interdite" });
  });

  test("après l'accord, la demande peut être refusée avec un motif ou renvoyée pour complément ; complétée, elle y revient (ticket #98)", () => {
    expect(checkTransition("ACCORD_RESPONSABLE", "REFUSEE", { comment: "Budget épuisé" })).toEqual({ ok: true });
    expect(checkTransition("ACCORD_RESPONSABLE", "REFUSEE")).toEqual({ ok: false, reason: "motif_obligatoire" });
    expect(checkTransition("ACCORD_RESPONSABLE", "A_COMPLETER")).toEqual({ ok: true });
    expect(checkTransition("A_COMPLETER", "ACCORD_RESPONSABLE")).toEqual({ ok: true });
  });
});

describe("pasEncoreDecidee", () => {
  test("seule une demande soumise, à compléter ou qui a reçu l'accord du responsable n'est pas encore décidée", () => {
    // Tous les statuts, sans exception : un statut ajouté doit être classé ici (ticket #94).
    const attendu: Record<RequestStatus, boolean> = {
      SOUMISE: true,
      A_COMPLETER: true,
      ACCORD_RESPONSABLE: true,
      APPROUVEE: false,
      REFUSEE: false,
      ANNULEE: false,
      CLE_EMISE: false,
      EXPIREE: false,
      REVOQUEE: false,
      DECLAREE: false,
      RENOUVELEE: false,
    };
    for (const [statut, pasDecidee] of Object.entries(attendu)) expect(pasEncoreDecidee(statut as RequestStatus), statut).toBe(pasDecidee);
  });

  test("son demandeur peut toujours annuler une demande pas encore décidée", () => {
    for (const statut of STATUTS_PAS_ENCORE_DECIDES) expect(checkTransition(statut, "ANNULEE"), statut).toEqual({ ok: true });
  });
});

describe("enAttenteDeValidation", () => {
  test("seule une demande soumise, ou qui a reçu l'accord du responsable, attend une validation ; une demande à compléter attend son demandeur", () => {
    // Tous les statuts, sans exception : un statut ajouté doit être classé ici.
    const attendu: Record<RequestStatus, boolean> = {
      SOUMISE: true,
      A_COMPLETER: false,
      ACCORD_RESPONSABLE: true,
      APPROUVEE: false,
      REFUSEE: false,
      ANNULEE: false,
      CLE_EMISE: false,
      EXPIREE: false,
      REVOQUEE: false,
      DECLAREE: false,
      RENOUVELEE: false,
    };
    for (const [statut, enAttente] of Object.entries(attendu)) expect(enAttenteDeValidation(statut as RequestStatus), statut).toBe(enAttente);
  });

  test("une demande en attente de validation n'est pas encore décidée, et peut être approuvée", () => {
    for (const statut of STATUTS_EN_ATTENTE_DE_VALIDATION) {
      expect(pasEncoreDecidee(statut), statut).toBe(true);
      expect(checkTransition(statut, "APPROUVEE"), statut).toEqual({ ok: true });
    }
  });
});

describe("où attend une demande de la file (spécification #93, ticket #96)", () => {
  const abonnement = { kind: "ABONNEMENT" as const, status: "SOUMISE" as const, requesterUid: "pmartin" };

  test("une demande d'abonnement soumise attend l'accord d'un responsable si son équipe en a un autre que son demandeur", () => {
    expect(attendUnResponsable(abonnement, ["lbernard"])).toBe(true);
    expect(attendUnResponsable(abonnement, [])).toBe(false);
    // La demande d'un responsable seul dans son équipe ; puis celle d'un responsable qui a un collègue.
    expect(attendUnResponsable({ ...abonnement, requesterUid: "lbernard" }, ["lbernard"])).toBe(false);
    expect(attendUnResponsable({ ...abonnement, requesterUid: "lbernard" }, ["lbernard", "pmartin"])).toBe(true);
  });

  test("une demande qui a reçu l'accord, une demande de clé ou d'accès à une équipe n'attend pas de responsable", () => {
    expect(attendUnResponsable({ ...abonnement, status: "ACCORD_RESPONSABLE" }, ["lbernard"])).toBe(false);
    expect(attendUnResponsable({ ...abonnement, kind: "CLE" }, ["lbernard"])).toBe(false);
    expect(attendUnResponsable({ ...abonnement, kind: "ADHESION_EQUIPE" }, ["lbernard"])).toBe(false);
  });

  test("toute la file attend un admin, sauf une demande d'abonnement qui attend l'accord d'un responsable qu'il n'est pas lui-même", () => {
    const admin = { uid: "jdupont", isAdmin: true };
    expect(attendLActeur(admin, abonnement, [])).toBe(true);
    expect(attendLActeur(admin, { ...abonnement, status: "ACCORD_RESPONSABLE" }, ["lbernard"])).toBe(true);
    expect(attendLActeur(admin, { ...abonnement, kind: "CLE" }, ["lbernard"])).toBe(true);
    expect(attendLActeur(admin, abonnement, ["lbernard"])).toBe(false);
    // Responsable de l'équipe, l'admin en reçoit les demandes et les approuve en un seul temps ; sa propre demande
    // attend l'accord de l'autre responsable.
    expect(attendLActeur(admin, abonnement, ["jdupont", "lbernard"])).toBe(true);
    expect(attendLActeur(admin, { ...abonnement, requesterUid: "jdupont" }, ["jdupont", "lbernard"])).toBe(false);
  });

  test("un responsable traite les demandes soumises de ses équipes, hors les siennes ; celles qui ont reçu l'accord attendent un admin", () => {
    const responsable = { uid: "lbernard", isAdmin: false };
    expect(attendLActeur(responsable, abonnement, ["lbernard"])).toBe(true);
    expect(attendLActeur(responsable, { ...abonnement, kind: "CLE" }, ["lbernard"])).toBe(true);
    expect(attendLActeur(responsable, { ...abonnement, status: "ACCORD_RESPONSABLE" }, ["lbernard"])).toBe(false);
    expect(attendLActeur(responsable, { ...abonnement, requesterUid: "lbernard" }, ["lbernard", "pmartin"])).toBe(false);
  });
});

describe("décider d'une demande (spécification #93, ticket #98)", () => {
  const admin = { uid: "jdupont", isAdmin: true };
  const responsable = { uid: "lbernard", isAdmin: false };
  const abonnement = { kind: "ABONNEMENT" as const, status: "SOUMISE" as const, requesterUid: "pmartin" };

  test("un responsable ne décide ni de sa propre demande, ni d'une demande qui a reçu l'accord ; un admin décide de toute la file", () => {
    expect(empechementDeDecider(responsable, abonnement)).toBeNull();
    expect(empechementDeDecider(responsable, { ...abonnement, requesterUid: "lbernard" })).toBe("quatre_yeux");
    expect(empechementDeDecider(responsable, { ...abonnement, status: "ACCORD_RESPONSABLE" })).toBe("interdit");
    expect(empechementDeDecider(admin, { ...abonnement, requesterUid: "jdupont", status: "ACCORD_RESPONSABLE" })).toBeNull();
  });

  test("sur une demande d'abonnement soumise, la fiche propose au responsable son accord ; à l'admin, l'approbation, avant comme après l'accord", () => {
    expect(decisionProposee(responsable, abonnement)).toBe("donnerAccord");
    expect(decisionProposee(responsable, { ...abonnement, status: "ACCORD_RESPONSABLE" })).toBeNull();
    for (const status of ["SOUMISE", "ACCORD_RESPONSABLE"] as const) expect(decisionProposee(admin, { ...abonnement, status }), status).toBe("approuver");
  });

  test("le responsable approuve une demande de clé ou accepte une demande d'accès, jamais la sienne ; une demande décidée ne propose plus rien", () => {
    expect(decisionProposee(responsable, { ...abonnement, kind: "CLE" })).toBe("approuver");
    expect(decisionProposee(responsable, { ...abonnement, kind: "ADHESION_EQUIPE" })).toBe("approuver");
    expect(decisionProposee(responsable, { ...abonnement, kind: "ADHESION_EQUIPE", requesterUid: "lbernard" })).toBeNull();
    expect(decisionProposee(admin, { ...abonnement, status: "APPROUVEE" })).toBeNull();
    expect(decisionProposee(admin, { ...abonnement, status: "A_COMPLETER" })).toBeNull();
  });

  test("complétée, une demande revient à l'accord du responsable s'il avait été donné, sauf si elle change d'équipe ou d'offre", () => {
    const avant = { agreedBy: "lbernard", teamId: "equipe-rd", offerId: "max" };
    expect(statutApresComplement(avant, { teamId: "equipe-rd", offerId: "max" })).toBe("ACCORD_RESPONSABLE");
    expect(statutApresComplement(avant, { teamId: "equipe-data", offerId: "max" })).toBe("SOUMISE");
    expect(statutApresComplement(avant, { teamId: "equipe-rd", offerId: "pro" })).toBe("SOUMISE");
    expect(statutApresComplement({ ...avant, agreedBy: null }, { teamId: "equipe-rd", offerId: "max" })).toBe("SOUMISE");
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
