"use client";

import { type ReactNode, useState } from "react";

/** Équipe proposée dans un formulaire de demande, avec la phrase qui dit qui validera la demande. */
export interface EquipeProposee {
  teamId: string;
  teamAlias: string;
  valideurs: string;
}

/**
 * Choix de l'équipe d'une demande (F-22) ; en dessous, qui la validera : les responsables de l'équipe choisie, sinon
 * les administrateurs. Le libellé du champ est fourni par la page, dans la langue du salarié.
 */
export function ChoixEquipe({ equipes, valeurInitiale, children }: { equipes: EquipeProposee[]; valeurInitiale?: string; children: ReactNode }) {
  const [choisie, setChoisie] = useState(valeurInitiale ?? equipes[0]?.teamId ?? "");
  const valideurs = equipes.find((e) => e.teamId === choisie)?.valideurs;
  return (
    <>
      <label>
        {children}
        <select name="teamId" required value={choisie} onChange={(e) => setChoisie(e.target.value)}>
          {equipes.map((e) => (
            <option key={e.teamId} value={e.teamId}>
              {e.teamAlias}
            </option>
          ))}
        </select>
      </label>
      {valideurs && (
        <p className="text-sm text-neutral-600" aria-live="polite">
          {valideurs}
        </p>
      )}
    </>
  );
}
