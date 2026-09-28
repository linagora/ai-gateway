import { Reponse, routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { revokeOwnKey } from "@/lib/services/keys";

/**
 * Révocation de sa propre clé, et d'elle seule, même par un responsable de l'équipe : la passerelle la refuse en
 * quelques secondes (contrat : POST /keys/{id}/revoke, périmètre cles).
 */
export const POST = routeApi<{ id: string }>("cles", async ({ acteur, deps, params }) => {
  await revokeOwnKey(deps, acteur, idDeDemande(params.id));
  return new Reponse(204);
});
