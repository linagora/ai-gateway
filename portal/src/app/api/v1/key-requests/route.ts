import { Reponse, routeApi } from "@/lib/integrations/api";
import { demandeDeCle, versDemandeDeCle } from "@/lib/integrations/saisies";
import { renewalDraft } from "@/lib/services/keys";
import { createKeyRequest } from "@/lib/services/requests";

/**
 * Demande de clé, examinée dans le portail avec les mêmes contrôles ; un renouvellement reprend le budget de la clé
 * d'origine (contrat : POST /key-requests, périmètre demandes).
 */
export const POST = routeApi("demandes", async ({ acteur, deps, corps }) => {
  const saisie = await corps(demandeDeCle);
  const origine = saisie.renewsRequestId ? await renewalDraft(deps, acteur, saisie.renewsRequestId) : null;
  const demande = { ...versDemandeDeCle(saisie, origine?.requestedBudget ?? null), renewsRequestId: saisie.renewsRequestId ?? null };
  return new Reponse(201, await createKeyRequest(deps, acteur, demande));
});
