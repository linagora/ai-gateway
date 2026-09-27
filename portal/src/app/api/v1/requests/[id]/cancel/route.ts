import { Reponse, routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { cancelRequest } from "@/lib/services/requests";

/** Annulation d'une demande pas encore approuvée (contrat : POST /requests/{id}/cancel, périmètre demandes). */
export const POST = routeApi<{ id: string }>("demandes", async ({ acteur, deps, params }) => {
  await cancelRequest(deps, acteur, idDeDemande(params.id));
  return new Reponse(204);
});
