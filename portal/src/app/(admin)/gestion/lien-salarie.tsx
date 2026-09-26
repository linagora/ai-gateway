import Link from "next/link";

/** Uid d'un salarié, en lien vers sa fiche dans la gestion (retours de l'utilisateur du 2026-09-26). */
export function LienSalarie({ uid }: { uid: string }) {
  return <Link href={`/gestion/salaries/${encodeURIComponent(uid)}`}>{uid}</Link>;
}
