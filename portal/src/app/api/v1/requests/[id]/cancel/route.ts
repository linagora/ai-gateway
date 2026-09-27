import { Reponse, routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { cancelRequest } from "@/lib/services/requests";

/**
 * Annulation d'une demande de clé ou d'accès à une équipe pas encore approuvée ; les demandes d'abonnement restent hors
 * de l'API (contrat : POST /requests/{id}/cancel, périmètre demandes).
 */
export const POST = routeApi<{ id: string }>("demandes", async ({ acteur, deps, params }) => {
  await cancelRequest(deps, acteur, idDeDemande(params.id), ["CLE", "ADHESION_EQUIPE"]);
  return new Reponse(204);
});
