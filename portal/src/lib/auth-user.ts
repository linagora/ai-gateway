import { isAdmin } from "./policy";

/** Claims attendus du SSO LemonLDAP::NG (PRD §4.3) : sub = uid LDAP. */
export interface OidcClaims {
  sub?: string | null;
  email?: string | null;
  name?: string | null;
}

/** Utilisateur connecté au portail, porté par la session. */
export interface SessionUser {
  uid: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

/**
 * F-01 / F-03 : utilisateur du portail à partir des claims OIDC.
 * `adminUidsSetting` est la valeur brute de PORTAL_ADMIN_UIDS (uid séparés par des virgules).
 */
export function toPortalUser(claims: OidcClaims, adminUidsSetting: string | undefined): SessionUser | null {
  const uid = claims.sub?.trim();
  const email = claims.email?.trim();
  if (!uid || !email) return null;
  const adminUids = (adminUidsSetting ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return { uid, email, name: claims.name?.trim() || uid, isAdmin: isAdmin(uid, adminUids) };
}
