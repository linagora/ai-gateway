"use client";

import { useState } from "react";
import { justificationBudgetExigee } from "@/lib/policy";
import { Obligatoire } from "../../../obligatoire";

/**
 * Budget demandé, prérempli avec le montant recommandé. La justification n'apparaît (et n'est exigée) qu'au-delà du
 * seuil, que le serveur rejoue à l'envoi.
 */
export function Budget(props: {
  parDefaut: number | null;
  valeurInitiale: number | null;
  seuil: number;
  justificationInitiale?: string;
  textes: { libelle: string; justification: string };
}) {
  const [montant, setMontant] = useState(String(props.valeurInitiale ?? props.parDefaut ?? ""));
  const depasse = justificationBudgetExigee(Number(montant), props.seuil);
  return (
    <>
      <label>
        {props.textes.libelle}
        <input
          type="number"
          name="requestedBudget"
          min="0.01"
          step="0.01"
          value={montant}
          onChange={(e) => setMontant(e.target.value)}
        />
      </label>
      {depasse && (
        <label>
          {props.textes.justification}
          <Obligatoire />
          <textarea name="budgetJustification" required rows={3} defaultValue={props.justificationInitiale ?? ""} />
        </label>
      )}
    </>
  );
}
