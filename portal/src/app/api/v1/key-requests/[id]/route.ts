import { Reponse, routeApi } from "@/lib/integrations/api";
import { complementDeCle, idDeDemande, versDemandeDeCle } from "@/lib/integrations/saisies";
import { completeRequest } from "@/lib/services/requests";

/** Complément d'une demande de clé renvoyée au collaborateur (contrat : PUT /key-requests/{id}, périmètre demandes). */
export const PUT = routeApi<{ id: string }>("demandes", async ({ acteur, deps, params, corps }) => {
  await completeRequest(deps, acteur, idDeDemande(params.id), versDemandeDeCle(await corps(complementDeCle)));
  return new Reponse(204);
});
