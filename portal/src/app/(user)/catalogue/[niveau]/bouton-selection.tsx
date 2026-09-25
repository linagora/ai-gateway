"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/** Envoie la sélection de modèles au formulaire de demande ; actif dès qu'un modèle est coché. */
export function BoutonSelection() {
  const t = useTranslations("niveau");
  const bouton = useRef<HTMLButtonElement>(null);
  const [nombre, setNombre] = useState(0);
  useEffect(() => {
    const formulaire = bouton.current?.form;
    if (!formulaire) return;
    const compter = () => setNombre(formulaire.querySelectorAll('input[name="modeles"]:checked').length);
    compter();
    formulaire.addEventListener("change", compter);
    return () => formulaire.removeEventListener("change", compter);
  }, []);
  return (
    <button ref={bouton} type="submit" disabled={nombre === 0} className="disabled:cursor-not-allowed disabled:opacity-50">
      {t("demanderSelection")}
      {nombre > 0 && ` (${nombre})`}
    </button>
  );
}
