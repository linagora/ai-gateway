import Link from "next/link";

export function AdminNav() {
  return (
    <nav className="mb-4 flex gap-4 text-sm">
      <Link href="/gestion/demandes">Demandes</Link>
      <Link href="/gestion/catalogue">Catalogue</Link>
      <Link href="/gestion/parametres">Valeurs par défaut</Link>
    </nav>
  );
}
