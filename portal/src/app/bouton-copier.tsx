"use client";

import { useState } from "react";

/** Copie un texte dans le presse-papiers et le confirme ; libellés fournis par la page, dans sa langue. */
export function BoutonCopier({ texte, libelle, libelleCopie, className }: { texte: string; libelle: string; libelleCopie: string; className?: string }) {
  const [copie, setCopie] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(texte);
        setCopie(true);
      }}
    >
      {copie ? libelleCopie : libelle}
    </button>
  );
}
