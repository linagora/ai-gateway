import { timingSafeEqual } from "node:crypto";
import { runDailyTask } from "@/lib/services/echeances";
import { getDeps } from "@/lib/session";

/** Jeton présenté identique au jeton configuré (comparaison en temps constant). */
function jetonValide(presente: string | null, attendu: string | undefined): boolean {
  if (!presente || !attendu) return false;
  const [a, b] = [Buffer.from(presente), Buffer.from(`Bearer ${attendu}`)];
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * F-45 : tâche quotidienne (rappels et expirations), appelée chaque matin par le cron du serveur depuis le
 * conteneur du portail. Protégée par PORTAL_TASK_TOKEN, et bloquée par Caddy depuis Internet.
 */
export async function POST(request: Request): Promise<Response> {
  if (!jetonValide(request.headers.get("authorization"), process.env.PORTAL_TASK_TOKEN)) {
    return new Response(null, { status: 401 });
  }
  return Response.json(await runDailyTask(getDeps()), { headers: { "Cache-Control": "no-store" } });
}
