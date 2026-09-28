import { Reponse, routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { pickUpKey } from "@/lib/services/keys";

/**
 * Retrait d'une clé approuvée : la clé n'est rendue qu'une fois, jamais mise en cache ni journalisée ; si la réponse se
 * perd, l'intégration propose le remplacement (contrat : POST /key-requests/{id}/pickup, périmètre cles).
 */
export const POST = routeApi<{ id: string }>("cles", async ({ acteur, deps, params }) => new Reponse(201, await pickUpKey(deps, acteur, idDeDemande(params.id))));
