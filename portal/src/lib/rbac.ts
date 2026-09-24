import type { SessionUser } from "./auth-user";
import { PortalError } from "./errors";

/** Contrôle d'autorisation rejoué dans chaque cas d'usage d'administration (brief §6). */
export function requireAdmin(user: SessionUser): void {
  if (!user.isAdmin) throw new PortalError("interdit", "Action réservée aux administrateurs.");
}
