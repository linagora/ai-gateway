import { PortalError } from "@/lib/errors";
import { transmissionCsv } from "@/lib/services/remboursements";
import { getCurrentUser, getDeps } from "@/lib/session";

/**
 * Fichier CSV d'une transmission à la comptabilité (remboursements), pour un admin. Une transmission inconnue, ou un
 * visiteur qui n'est pas admin, reçoit une réponse 404, comme pour une page de la gestion.
 */
export async function GET(_request: Request, ctx: RouteContext<"/gestion/remboursements/transmissions/[id]/csv">) {
  const [{ id }, user] = await Promise.all([ctx.params, getCurrentUser()]);
  if (!user) return new Response(null, { status: 404 });
  try {
    const { fileName, content } = await transmissionCsv(getDeps(), user, id);
    return new Response(content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof PortalError && (e.code === "interdit" || e.code === "introuvable")) return new Response(null, { status: 404 });
    throw e;
  }
}
