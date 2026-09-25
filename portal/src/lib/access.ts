import { parseUidList, type SessionUser } from "./auth-user";

/**
 * Point de contrôle des services exposés sous le domaine du portail : Caddy interroge le portail
 * (forward_auth) avant chaque requête vers /admin (console LiteLLM) et /stats (Superset). Un seul
 * client OIDC (le portail) ; les listes d'uid autorisés sont gérées par Linagora, pas par le SSO.
 */
export type GatedService = "admin" | "stats";

export type AccessDecision = { kind: "allow"; headers: Record<string, string> } | { kind: "login"; location: string } | { kind: "deny" };

export interface AccessContext {
  /** Origine publique du portail (AUTH_URL). */
  portalOrigin: string;
  /** Chemin demandé à l'origine (X-Forwarded-Uri), pour y revenir après la connexion. */
  originalUri: string | null;
  /** Valeur brute de PORTAL_REPORTING_UIDS. */
  reportingUidsSetting: string | undefined;
}

export function decideServiceAccess(user: SessionUser | null, service: GatedService, ctx: AccessContext): AccessDecision {
  if (!user) {
    const callbackUrl = `${ctx.portalOrigin}${localPath(ctx.originalUri)}`;
    return { kind: "login", location: `${ctx.portalOrigin}/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}` };
  }
  if (user.isAdmin) return allow(user, "admin");
  if (service === "stats" && parseUidList(ctx.reportingUidsSetting).includes(user.uid)) return allow(user, "reader");
  return { kind: "deny" };
}

/** En-têtes d'identité transmis au service ; le nom est encodé (les en-têtes HTTP n'acceptent pas les accents). */
function allow(user: SessionUser, role: "admin" | "reader"): AccessDecision {
  return {
    kind: "allow",
    headers: { "X-Portal-User": user.uid, "X-Portal-Role": role, "X-Portal-Email": user.email, "X-Portal-Name": encodeURIComponent(user.name) },
  };
}

/** Seul un chemin local (« /… » mais pas « //… ») peut servir d'adresse de retour. */
function localPath(uri: string | null): string {
  return uri && uri.startsWith("/") && !uri.startsWith("//") ? uri : "/";
}
