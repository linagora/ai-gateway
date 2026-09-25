import type { NextRequest } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { decideServiceAccess, type GatedService } from "@/lib/access";
import { getCurrentUser } from "@/lib/session";

const SERVICES: readonly GatedService[] = ["admin", "stats"];

/** Page de refus, dans la langue de la requête (choix mémorisé du portail, sinon langue du navigateur). */
async function deniedPage(): Promise<string> {
  const [langue, t] = await Promise.all([getLocale(), getTranslations("refus")]);
  return `<!doctype html><html lang="${langue}"><meta charset="utf-8"><title>${t("titre")}</title>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>${t("titre")}</h1>
<p>${t("message")}</p>
<p><a href="/">${t("retour")}</a></p></body></html>`;
}

/** Appelé par Caddy (forward_auth) avant chaque requête vers /admin (console LiteLLM) et /stats (Superset). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/acces/[service]">): Promise<Response> {
  const { service } = await ctx.params;
  if (!SERVICES.includes(service as GatedService)) return new Response(null, { status: 404 });

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
      return new Response(await deniedPage(), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", ...noStore } });
  }
}
