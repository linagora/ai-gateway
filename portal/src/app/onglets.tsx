"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useSyncExternalStore } from "react";

/** Onglet d'un menu : son lien, son contenu, et les chemins des pages qui en relèvent (par défaut, son lien). */
export interface Onglet {
  href: string;
  contenu: ReactNode;
  sections?: string[];
}

/**
 * Liens d'un menu, dont l'onglet de la page courante est marqué (aria-current) et souligné du rouge LINAGORA (retours
 * de l'utilisateur du 2026-09-26). Une page relève de l'onglet dont une section est le plus long début de son chemin :
 * /demandes/nouvelle relève de « Nouvelle demande », pas de « Mes demandes ». Chaque lien réserve la place du trait,
 * en haut comme en bas pour rester aligné sur le texte voisin : rien ne bouge d'un onglet à l'autre.
 */
export function Onglets({ onglets }: { onglets: Onglet[] }) {
  const chemin = usePathname();
  // Une navigation lancée avant la fin de l'hydratation (clic pendant le chargement) change l'adresse sous le HTML du
  // serveur, et React ne corrige pas les attributs à l'hydratation : les liens sont recréés une fois la page hydratée,
  // avec ceux de l'adresse réelle.
  const hydratee = useSyncExternalStore(sansAbonnement, () => true, () => false);
  const longueurs = onglets.map((o) =>
    Math.max(0, ...(o.sections ?? [o.href]).filter((s) => chemin === s || chemin.startsWith(`${s}/`)).map((s) => s.length)),
  );
  const plusLongue = Math.max(0, ...longueurs);
  const actif = plusLongue > 0 ? longueurs.indexOf(plusLongue) : -1;
  return onglets.map((o, i) => (
    <Link
      key={hydratee ? o.href : `${o.href} (serveur)`}
      suppressHydrationWarning
      href={o.href}
      aria-current={i === actif ? (chemin === o.href ? "page" : "true") : undefined}
      className={`border-y-[3px] border-t-transparent py-0.5 ${i === actif ? "border-b-linagora text-neutral-900" : "border-b-transparent"}`}
    >
      {o.contenu}
    </Link>
  ));
}

/** Aucun abonnement : l'état « hydratée » ne change qu'une fois, à la fin de l'hydratation. */
const sansAbonnement = () => () => {};
