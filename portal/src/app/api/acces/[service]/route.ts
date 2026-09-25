import type { NextRequest } from "next/server";
import { decideServiceAccess, type GatedService } from "@/lib/access";
import { getCurrentUser } from "@/lib/session";

const SERVICES: readonly GatedService[] = ["admin", "stats"];

const DENIED_PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Accès réservé</title>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>Accès réservé</h1>
<p>Votre compte n'est pas autorisé pour ce service. Si vous pensez que c'est une erreur, contactez un administrateur du portail.</p>
<p><a href="/">Retour au portail</a></p></body></html>`;

/** Appelé par Caddy (forward_auth) avant chaque requête vers /admin (console LiteLLM) et /stats (Superset). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/acces/[service]">): Promise<Response> {
  const { service } = await ctx.params;
  if (!SERVICES.includes(service as GatedService)) return new Response("Service inconnu", { status: 404 });

  const decision = decideServiceAccess(await getCurrentUser(), service as GatedService, {
    portalOrigin: new URL(process.env.AUTH_URL ?? request.nextUrl.origin).origin,
    originalUri: request.headers.get("x-forwarded-uri"),
    reportingUidsSetting: process.env.PORTAL_REPORTING_UIDS,
  });
  const noStore = { "Cache-Control": "no-store" };
  switch (decision.kind) {
    case "allow":
      return new Response(null, { status: 200, headers: { ...decision.headers, ...noStore } });
    case "login":
      return new Response(null, { status: 302, headers: { Location: decision.location, ...noStore } });
    case "deny":
      return new Response(DENIED_PAGE, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", ...noStore } });
  }
}
