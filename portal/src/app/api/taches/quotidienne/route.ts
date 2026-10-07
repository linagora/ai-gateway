import { jetonDeTacheValide } from "@/lib/jeton-tache";
import { runDailyTask } from "@/lib/services/echeances";
import { getDeps } from "@/lib/session";

/**
 * F-45 : tâche quotidienne (rappels et expirations), appelée chaque matin par le cron du serveur depuis le
 * conteneur du portail. Protégée par PORTAL_TASK_TOKEN, et bloquée par Caddy depuis Internet.
 */
export async function POST(request: Request): Promise<Response> {
  if (!jetonDeTacheValide(request.headers.get("authorization"))) {
    return new Response(null, { status: 401 });
  }
  return Response.json(await runDailyTask(getDeps()), { headers: { "Cache-Control": "no-store" } });
}
