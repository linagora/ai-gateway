import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { type SessionUser, toPortalUser } from "@/lib/auth-user";
import { addressesFromEnv, mailerFromEnv } from "@/lib/courriel";
import { getDb } from "@/lib/db";
import { getLiteLLM } from "@/lib/litellm/instance";
import { LimiteDeDebit } from "@/lib/limite-de-debit";
import { equipesGerees } from "@/lib/services/autorite";

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

/**
 * Pages de gestion ouvertes aux responsables d'équipe (demandes, clés, équipes, limitées à leurs équipes par les
 * services) ; pour les autres salariés, la page n'existe pas (404).
 */
export async function requireGestionPage(): Promise<SessionUser> {
  const user = await requireUser();
  const equipes = await equipesGerees(getDb(), user);
  if (equipes !== null && equipes.length === 0) notFound();
  return user;
}

/** Pages de gestion réservées aux admins (catalogue, valeurs par défaut, outils) ; pour les autres, 404. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) notFound();
  return user;
}

/** Au plus cinq retraits ou remplacements de clé par titulaire en dix minutes (spécification #14). */
const limiteGenerations = new LimiteDeDebit(5, 10 * 60_000);

/** Dépendances réelles des cas d'usage ; sans configuration SMTP, aucun courriel n'est envoyé. */
export function getDeps() {
  return {
    db: getDb(),
    litellm: getLiteLLM(),
    limiteGenerations,
    mailer: mailerFromEnv(),
    adminEmails: addressesFromEnv(process.env.ADMIN_NOTIFICATION_EMAILS),
    portalUrl: process.env.AUTH_URL,
  };
}
