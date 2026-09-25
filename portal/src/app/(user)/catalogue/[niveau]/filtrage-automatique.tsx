"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Applique les critères du formulaire qui la contient dès qu'ils changent, sans bouton : la page se recalcule
 * côté serveur par une navigation qui garde le défilement et le champ en cours de saisie. La recherche ne
 * filtre qu'à partir de `minimum` caractères (règle rejouée par le serveur), après un court délai de frappe.
 */
export function FiltrageAutomatique({ minimum }: { minimum: number }) {
  const ancre = useRef<HTMLSpanElement>(null);
  const router = useRouter();

  useEffect(() => {
    const form = ancre.current?.closest("form");
    if (!form) return;
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const appliquer = () => {
      clearTimeout(minuterie);
      const params = new URLSearchParams();
      for (const [nom, valeur] of new FormData(form)) {
        if (typeof valeur !== "string" || valeur.trim() === "" || (nom === "q" && valeur.trim().length < minimum)) continue;
        params.append(nom, valeur);
      }
      const recherche = params.toString();
      if (recherche !== window.location.search.replace(/^\?/, "")) {
        router.replace(`${window.location.pathname}${recherche ? `?${recherche}` : ""}`, { scroll: false });
      }
    };
    const surSaisie = (e: Event) => {
      if ((e.target as HTMLInputElement).type !== "search") return appliquer();
      clearTimeout(minuterie);
      minuterie = setTimeout(appliquer, 300);
    };
    const surEnvoi = (e: SubmitEvent) => {
      e.preventDefault();
      appliquer();
    };
    form.addEventListener("input", surSaisie);
    form.addEventListener("submit", surEnvoi);
    return () => {
      clearTimeout(minuterie);
      form.removeEventListener("input", surSaisie);
      form.removeEventListener("submit", surEnvoi);
    };
  }, [minimum, router]);

  return <span ref={ancre} hidden />;
}
