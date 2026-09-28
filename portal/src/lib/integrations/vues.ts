import type { RequestKind, RequestStatus } from "@/generated/prisma/client";
import { CLASSIFICATIONS_ACCEPTEES, DATA_LEVELS, modelAcceptsLevel } from "@/lib/policy";
import type { CatalogItem } from "@/lib/services/catalog";
import type { MyKeys, renewalDraft } from "@/lib/services/keys";
import type { RequestSummary } from "@/lib/services/requests";
import type { Traducteur } from "./api";

/**
 * Vues de l'API d'intégration (contrat openapi-v1.json) : ce que montrent les pages du portail au collaborateur, avec
 * les noms anglais du contrat pour les types et les statuts, les dates en ISO 8601 et les textes dans la langue demandée.
 */

/** Types de demande de l'API : les demandes d'abonnement n'y figurent pas. */
const TYPES_DU_CONTRAT: Partial<Record<RequestKind, string>> = { CLE: "KEY", ADHESION_EQUIPE: "TEAM_ACCESS" };

/** Statuts des demandes de clé et d'accès à une équipe, tels que les nomme l'API. */
const STATUTS_DU_CONTRAT: Partial<Record<RequestStatus, string>> = {
  SOUMISE: "SUBMITTED",
  A_COMPLETER: "NEEDS_COMPLETION",
  APPROUVEE: "APPROVED",
  REFUSEE: "REFUSED",
  ANNULEE: "CANCELLED",
  CLE_EMISE: "KEY_ISSUED",
  EXPIREE: "EXPIRED",
  REVOQUEE: "REVOKED",
};

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Demandes du collaborateur (GET /requests), les plus récentes d'abord. */
export function vueDemandes(demandes: RequestSummary[], t: Traducteur) {
  return {
    requests: demandes.flatMap((d) => {
      const [kind, status] = [TYPES_DU_CONTRAT[d.kind], STATUTS_DU_CONTRAT[d.status]];
      if (!kind || !status) return [];
      return [
        {
          id: d.id,
          kind,
          teamId: d.teamId,
          teamAlias: d.teamAlias,
          dataLevel: d.dataLevel,
          models: d.models,
          status,
          statusLabel: t(`domaine.statuts.${d.status}`),
          decisionComment: d.decisionComment,
          renewsRequestId: d.renewsRequestId,
          createdAt: d.createdAt.toISOString(),
        },
      ];
    }),
  };
}

/** Clés du collaborateur (GET /keys) : à retirer, puis émises, avec leur état lu dans la passerelle ; jamais la clé. */
export function vueCles({ toPickUp, keys }: MyKeys, t: Traducteur) {
  return {
    toPickUp: toPickUp.map((k) => ({
      requestId: k.requestId,
      teamId: k.teamId,
      teamAlias: k.teamAlias,
      dataLevel: k.dataLevel,
      models: k.models,
      project: k.project,
      pickupDeadline: iso(k.pickupDeadline),
    })),
    keys: keys.map((k) => ({
      requestId: k.requestId,
      alias: k.alias,
      teamId: k.teamId,
      teamAlias: k.teamAlias,
      dataLevel: k.dataLevel,
      models: k.models,
      project: k.project,
      issuedAt: k.issuedAt.toISOString(),
      expiresAt: iso(k.expiresAt),
      status: STATUTS_DU_CONTRAT[k.status],
      statusLabel: t(`domaine.statuts.${k.status}`),
      gateway: k.gatewayState && {
        spend: k.gatewayState.spend,
        maxBudget: k.gatewayState.maxBudget,
        budgetResetAt: iso(k.gatewayState.budgetResetAt),
        blocked: k.gatewayState.blocked,
      },
    })),
  };
}

/**
 * Brouillon de renouvellement d'une clé (GET /keys/{id}/renewal-draft) : de quoi préremplir sa demande de
 * renouvellement ; le budget n'y figure pas, le portail reprenant celui de la clé renouvelée.
 */
export function vueBrouillonDeRenouvellement({ alias, teamId, dataLevel, models, project, requestedDays }: Awaited<ReturnType<typeof renewalDraft>>) {
  return { alias, teamId, dataLevel, models, project, requestedDays };
}

/**
 * Catalogue visible (GET /catalog) : le texte exact de l'engagement du formulaire de demande de clé, les niveaux avec
 * les classifications qu'ils acceptent et les modèles qui les acceptent, puis les modèles.
 */
export function vueCatalogue(modeles: CatalogItem[], t: Traducteur) {
  return {
    commitment: t("nouvelleDemande.engagement"),
    levels: DATA_LEVELS.map((niveau) => ({
      id: niveau,
      name: t(`domaine.niveaux.${niveau}`),
      classifications: CLASSIFICATIONS_ACCEPTEES[niveau],
      models: modeles.filter((m) => modelAcceptsLevel(m.dataLevel, niveau)).map((m) => m.modelName),
    })),
    models: modeles.map((m) => ({
      modelName: m.modelName,
      displayName: m.displayName,
      description: m.description,
      dataLevel: m.dataLevel,
      useCases: m.useCases,
      publisher: m.publisher,
      executionRegion: m.executionRegion,
      inputPricePerMillion: m.inputPricePerMillion,
      outputPricePerMillion: m.outputPricePerMillion,
      maxInputTokens: m.maxInputTokens,
    })),
  };
}
