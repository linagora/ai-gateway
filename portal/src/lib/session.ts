import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { type SessionUser, toPortalUser } from "@/lib/auth-user";
import { getDb } from "@/lib/db";
import { getLiteLLM } from "@/lib/litellm/instance";

/**
 * Couche d'accès aux données (DAL) : l'utilisateur courant, reconstruit à chaque requête. Le rôle
 * admin est recalculé depuis PORTAL_ADMIN_UIDS, pour qu'un retrait prenne effet sans attendre 8 h.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  if (!session?.user?.uid) return null;
  return toPortalUser({ sub: session.user.uid, email: session.user.email, name: session.user.name }, process.env.PORTAL_ADMIN_UIDS);
});

/** Pages et Server Actions : utilisateur connecté, sinon redirection vers la connexion SSO. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/signin");
  return user;
}

/** Pages de gestion : réservées aux admins ; pour les autres, la page n'existe pas (404). */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) notFound();
  return user;
}

/** Dépendances réelles des cas d'usage. */
export function getDeps() {
  return { db: getDb(), litellm: getLiteLLM() };
}
