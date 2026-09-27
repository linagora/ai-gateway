import { routeApi } from "@/lib/integrations/api";
import { vueDemandes } from "@/lib/integrations/vues";
import { listMyRequests } from "@/lib/services/requests";

/** Demandes du collaborateur, les plus récentes d'abord (contrat : GET /requests, périmètre lecture). */
export const GET = routeApi("lecture", async ({ acteur, deps, t }) => vueDemandes(await listMyRequests(deps, acteur), t));
