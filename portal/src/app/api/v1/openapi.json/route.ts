import { routeApi } from "@/lib/integrations/api";
import contrat from "@/lib/integrations/openapi-v1.json";

/** Contrat de l'API de la version déployée (contrat : GET /openapi.json, périmètre lecture). */
export const GET = routeApi("lecture", async () => contrat);
