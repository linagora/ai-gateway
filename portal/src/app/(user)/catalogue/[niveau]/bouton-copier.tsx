"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/** Copie un texte dans le presse-papiers et le confirme. */
export function BoutonCopier({ texte }: { texte: string }) {
  const t = useTranslations("detail");
  const [copie, setCopie] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(texte);
        setCopie(true);
      }}
    >
      {copie ? t("copie") : t("copier")}
    </button>
  );
}
