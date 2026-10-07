import { jetonDeTacheValide } from "@/lib/jeton-tache";
import { superviserModeles } from "@/lib/services/supervision";
import { getDeps } from "@/lib/session";

/**
 * Passage manuel de la supervision des modèles, hors de la sonde planifiée dans le portail (src/instrumentation.ts) :
 * depuis le serveur, ou pour un outil de surveillance du réseau interne. Protégée par PORTAL_TASK_TOKEN, comme la tâche
 * quotidienne, et bloquée par Caddy depuis Internet. Le compte rendu donne les modèles en panne ; le statut 503 en
 * signale au moins un, pour un outil qui ne lirait que le statut.
 */
export async function POST(request: Request): Promise<Response> {
  if (!jetonDeTacheValide(request.headers.get("authorization"))) {
    return new Response(null, { status: 401 });
  }
  const rapport = await superviserModeles(getDeps());
  return Response.json(rapport, { status: rapport.enPanne.length > 0 ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
