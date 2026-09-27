import { routeApi } from "@/lib/integrations/api";
import { listMyTeams } from "@/lib/services/requests";

/** Équipes du collaborateur, pour lesquelles il peut demander une clé (contrat : GET /me/teams, périmètre lecture). */
export const GET = routeApi("lecture", async ({ acteur, deps }) => ({
  teams: (await listMyTeams(deps, acteur)).map(({ teamId, teamAlias }) => ({ teamId, teamAlias })),
}));
