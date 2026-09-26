"use client";

import { ExternalLink } from "lucide-react";
import Form from "next/form";
import { type ReactNode, useState } from "react";
import type { DataLevel } from "@/lib/policy";

/** Offre d'un fournisseur, avec ses textes déjà mis en forme, dans la langue du salarié, par la page. */
export interface OffreAffichee {
  id: string;
  /** Libellé dans la liste, court pour tenir dans la carte : « Claude Pro · 21,60 € » (le prix TTC par mois suit). */
  option: string;
  prix: string;
  niveau: DataLevel;
  libelleNiveau: string;
  regles: string;
  url: string | null;
}

/**
 * Choix d'une offre d'un fournisseur dans une liste, qui montre le prix, les pastilles du niveau maximal, les règles
 * d'usage et le lien de l'offre choisie ; « Demander cet abonnement » ouvre le formulaire de demande de cette offre.
 * Sans JavaScript, le formulaire mène tout de même à la demande de l'offre choisie.
 */
export function ChoixOffre({
  offres,
  pastilles,
  libelles,
}: {
  offres: OffreAffichee[];
  /** Pastilles de classification de chaque niveau présent, rendues par la page. */
  pastilles: Partial<Record<DataLevel, ReactNode>>;
  libelles: { offre: string; regles: string; lienFournisseur: string; demander: string };
}) {
  const [choisie, setChoisie] = useState(offres[0].id);
  const offre = offres.find((o) => o.id === choisie) ?? offres[0];
  return (
    <Form action="/demandes/abonnement" className="flex flex-1 flex-col">
      <label className="mt-3">
        {libelles.offre}
        <select name="offre" value={offre.id} onChange={(e) => setChoisie(e.target.value)}>
          {offres.map((o) => (
            <option key={o.id} value={o.id}>
              {o.option}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3">{pastilles[offre.niveau]}</div>
      <p className="mt-2 font-semibold">{offre.prix}</p>
      <p className="text-sm">{offre.libelleNiveau}</p>
      <h3 className="mt-2.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{libelles.regles}</h3>
      <p className="mt-1 text-sm">{offre.regles}</p>
      <div className="mt-auto pt-3">
        {offre.url && (
          <p className="text-sm">
            <a href={offre.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
              {libelles.lienFournisseur}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </p>
        )}
        <button type="submit">{libelles.demander}</button>
      </div>
    </Form>
  );
}
