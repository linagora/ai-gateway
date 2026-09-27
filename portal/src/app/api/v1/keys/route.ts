import { routeApi } from "@/lib/integrations/api";
import { vueCles } from "@/lib/integrations/vues";
import { listMyKeys } from "@/lib/services/keys";

/** Clés du collaborateur : à retirer, puis émises, jamais leur valeur (contrat : GET /keys, périmètre lecture). */
export const GET = routeApi("lecture", async ({ acteur, deps, t }) => vueCles(await listMyKeys(deps, acteur), t));
