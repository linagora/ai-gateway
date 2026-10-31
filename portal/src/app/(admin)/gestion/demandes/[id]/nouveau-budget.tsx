"use client";

import { useState } from "react";
import { montantAuCentime } from "@/lib/policy";
import { Obligatoire } from "../../../../obligatoire";

/**
 * Nouveau plafond d'une hausse de budget, prérempli avec le montant demandé. L'avertissement de dépassement du budget
 * de l'équipe (null : sans plafond d'équipe) suit le montant que saisit le valideur.
 */
export function NouveauBudget(props: {
  minimum: number;
  valeurInitiale: number | null;
  budgetEquipe: number | null;
  textes: { libelle: string; depasseEquipe: string };
}) {
  const [montant, setMontant] = useState(String(props.valeurInitiale ?? ""));
  const depasse = props.budgetEquipe !== null && montantAuCentime(Number(montant)) > props.budgetEquipe;
  return (
    <>
      <label>
        {props.textes.libelle}
        <Obligatoire />
        <input name="budget" type="number" min={props.minimum} step="0.01" required value={montant} onChange={(e) => setMontant(e.target.value)} />
      </label>
      <div aria-live="polite">{depasse && <p className="rounded border-l-4 border-amber-500 bg-amber-50 px-3 py-2">{props.textes.depasseEquipe}</p>}</div>
    </>
  );
}
