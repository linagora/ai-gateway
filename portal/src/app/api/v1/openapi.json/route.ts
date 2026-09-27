import { routeApi } from "@/lib/integrations/api";
import contrat from "@/lib/integrations/openapi-v1.json";

/** Contrat de l'API de la version déployée, pour toute intégration authentifiée (contrat : GET /openapi.json). */
export const GET = routeApi(null, async () => contrat);
