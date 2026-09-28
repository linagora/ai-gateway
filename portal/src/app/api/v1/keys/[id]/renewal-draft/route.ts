import { routeApi } from "@/lib/integrations/api";
import { idDeDemande } from "@/lib/integrations/saisies";
import { vueBrouillonDeRenouvellement } from "@/lib/integrations/vues";
import { renewalDraft } from "@/lib/services/keys";

/**
 * Brouillon de renouvellement de sa propre clé, pour préremplir la demande de renouvellement (contrat :
 * GET /keys/{id}/renewal-draft, périmètre cles).
 */
export const GET = routeApi<{ id: string }>("cles", async ({ acteur, deps, params }) => vueBrouillonDeRenouvellement(await renewalDraft(deps, acteur, idDeDemande(params.id))));
