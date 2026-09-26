import Link from "next/link";

/** Uid d'un collaborateur, en lien vers sa fiche dans la gestion (retours de l'utilisateur du 2026-09-26). */
export function LienCollaborateur({ uid }: { uid: string }) {
  return <Link href={`/gestion/collaborateurs/${encodeURIComponent(uid)}`}>{uid}</Link>;
}
