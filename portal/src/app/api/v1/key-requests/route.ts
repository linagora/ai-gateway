import { Reponse, routeApi } from "@/lib/integrations/api";
import { demandeDeCle, versDemandeDeCle } from "@/lib/integrations/saisies";
import { createKeyRequest } from "@/lib/services/requests";

/**
 * Demande de clé, examinée dans le portail avec les mêmes contrôles ; un renouvellement désigne la demande de la clé
 * renouvelée (contrat : POST /key-requests, périmètre demandes).
 */
export const POST = routeApi("demandes", async ({ acteur, deps, corps }) => {
  const saisie = await corps(demandeDeCle);
  return new Reponse(201, await createKeyRequest(deps, acteur, { ...versDemandeDeCle(saisie), renewsRequestId: saisie.renewsRequestId ?? null }));
});
