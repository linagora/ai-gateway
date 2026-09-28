import { Reponse, routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { replaceKey } from "@/lib/services/keys";

/**
 * Remplacement d'une clé perdue : une nouvelle clé aux mêmes paramètres, expiration et dépense, rendue une seule fois ;
 * l'ancienne est supprimée (contrat : POST /keys/{id}/replace, périmètre cles).
 */
export const POST = routeApi<{ id: string }>("cles", async ({ acteur, deps, params }) => new Reponse(201, await replaceKey(deps, acteur, idDeDemande(params.id))));
