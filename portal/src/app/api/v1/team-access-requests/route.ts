import { Reponse, routeApi } from "@/lib/integrations/api";
import { demandeDAcces } from "@/lib/integrations/saisies";
import { createTeamJoinRequest } from "@/lib/services/requests";

/** Demande d'accès à une équipe, examinée dans le portail (contrat : POST /team-access-requests, périmètre demandes). */
export const POST = routeApi("demandes", async ({ acteur, deps, corps }) => new Reponse(201, await createTeamJoinRequest(deps, acteur, await corps(demandeDAcces))));
