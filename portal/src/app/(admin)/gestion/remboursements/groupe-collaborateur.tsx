"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/** Prélèvement d'un collaborateur, avec ses textes déjà mis en forme par la page. */
export interface PrelevementAffiche {
  id: string;
  offre: string;
  equipe: string;
  date: string;
  retard: string | null;
  ht: string;
  ttc: string;
}

/**
 * Groupe d'un collaborateur dans la liste des remboursements : une ligne de synthèse (collaborateur, nombre de
 * prélèvements, totaux HT et TTC) dont le chevron déplie ou replie le détail de ses prélèvements, replié d'abord ; à
 * l'impression, le détail est toujours déplié.
 */
export function GroupeCollaborateur({
  uid,
  nom,
  adresse,
  resume,
  totalHt,
  totalTtc,
  prelevements,
}: {
  uid: string;
  nom: string | null;
  adresse: string;
  resume: string;
  totalHt: string;
  totalTtc: string;
  prelevements: PrelevementAffiche[];
}) {
  const [deplie, setDeplie] = useState(false);
  const Chevron = deplie ? ChevronDown : ChevronRight;
  return (
    <tbody aria-label={nom ?? uid}>
      <tr>
        <td className="align-top">
          <button
            type="button"
            aria-expanded={deplie}
            aria-controls={prelevements.map((p) => `prelevement-${p.id}`).join(" ")}
            onClick={() => setDeplie(!deplie)}
            className="m-0 inline-flex items-start gap-1 border-0 bg-transparent p-0 text-left font-medium text-neutral-900 hover:bg-transparent"
          >
            <Chevron aria-hidden="true" className="mt-0.5 size-4 shrink-0 print:hidden" />
            {nom ?? uid}
          </button>
          <Link href={`/gestion/collaborateurs/${encodeURIComponent(uid)}`} className="block pl-5 text-sm print:pl-0">
            {uid}
          </Link>
          <span className="block pl-5 text-xs text-neutral-600 print:pl-0">{adresse}</span>
        </td>
        <td colSpan={3} className="align-top text-sm text-neutral-700">
          {resume}
        </td>
        <td className="text-right align-top font-semibold">{totalHt}</td>
        <td className="text-right align-top font-semibold">{totalTtc}</td>
      </tr>
      {prelevements.map((p) => (
        <tr key={p.id} id={`prelevement-${p.id}`} className={deplie ? "" : "hidden print:table-row"}>
          <td />
          <td>{p.offre}</td>
          <td>{p.equipe}</td>
          <td>
            {p.date}
            {p.retard && <span className="block text-xs text-amber-800">{p.retard}</span>}
          </td>
          <td className="text-right">{p.ht}</td>
          <td className="text-right">{p.ttc}</td>
        </tr>
      ))}
    </tbody>
  );
}
