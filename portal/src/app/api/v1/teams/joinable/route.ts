import { routeApi } from "@/lib/integrations/api";
import { listJoinableTeams } from "@/lib/services/requests";

/** Équipes que le collaborateur peut demander à rejoindre (contrat : GET /teams/joinable, périmètre lecture). */
export const GET = routeApi("lecture", async ({ acteur, deps }) => ({
  teams: (await listJoinableTeams(deps, acteur)).map(({ teamId, teamAlias }) => ({ teamId, teamAlias })),
}));
