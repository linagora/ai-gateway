"use client";

import { Printer } from "lucide-react";

/** Ouvre l'impression du navigateur, qui permet aussi d'enregistrer la page en PDF (mise en page d'impression de la liste). */
export function BoutonImprimer({ libelle }: { libelle: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="m-0 inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[#1d4ed8] hover:bg-transparent hover:underline"
    >
      <Printer aria-hidden="true" className="size-4" />
      {libelle}
    </button>
  );
}
