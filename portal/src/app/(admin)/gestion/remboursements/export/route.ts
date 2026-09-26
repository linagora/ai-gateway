import type { NextRequest } from "next/server";
import { PortalError } from "@/lib/errors";
import { exportChargesToReimburse } from "@/lib/services/remboursements";
import { getCurrentUser, getDeps } from "@/lib/session";

/**
 * Export Excel de la liste des remboursements à transmettre d'un mois (?mois=AAAA-MM), pour un admin, sans rien
 * transmettre. Un visiteur qui n'est pas admin reçoit une réponse 404, comme pour une page de la gestion.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 404 });
  try {
    const { fileName, content } = await exportChargesToReimburse(getDeps(), user, request.nextUrl.searchParams.get("mois") ?? "");
    return new Response(new Uint8Array(content), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof PortalError && e.code === "interdit") return new Response(null, { status: 404 });
    if (e instanceof PortalError && e.code === "mois_invalide") return new Response(null, { status: 400 });
    throw e;
  }
}
