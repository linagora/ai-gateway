import { routeApi } from "@/lib/integrations/api";
import { vueCatalogue } from "@/lib/integrations/vues";
import { listCatalog } from "@/lib/services/catalog";

/** Catalogue visible, avec l'engagement exact de la demande de clé (contrat : GET /catalog, périmètre lecture). */
export const GET = routeApi("lecture", async ({ deps, langue, t }) => vueCatalogue(await listCatalog(deps, langue), t));
