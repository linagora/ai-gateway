import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { signOutAction } from "./actions";

/** Nom de l'utilisateur, accès à la gestion (admins) et déconnexion. */
export async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) return null;
  return (
    <div className="ml-auto flex items-center gap-4">
      {user.isAdmin && <Link href="/gestion/demandes">Gestion</Link>}
      <span>{user.name}</span>
      <form action={signOutAction}>
        <button type="submit" className="mt-0">
          Se déconnecter
        </button>
      </form>
    </div>
  );
}

/** Message de succès ou d'erreur transmis par une Server Action (paramètres ok / erreur). */
export function Notice({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const ok = typeof searchParams.ok === "string" ? searchParams.ok : null;
  const erreur = typeof searchParams.erreur === "string" ? searchParams.erreur : null;
  if (erreur) return <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800" role="alert">{erreur}</p>;
  if (ok) return <p className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-green-800" role="status">{ok}</p>;
  return null;
}

export function euros(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 4 })} €`;
}

export function dateFr(value: Date): string {
  return value.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
