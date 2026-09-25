"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { ResultatRetrait } from "../../actions";
import { BoutonCopier } from "../../bouton-copier";

/**
 * Génère une clé (retrait ou remplacement) puis l'affiche une seule fois, jusqu'à « J'ai copié ma clé » :
 * la page n'est rafraîchie qu'ensuite, pour que le panneau reste ouvert.
 */
export function GenerationCle({
  requestId,
  action,
  libelle,
}: {
  requestId: string;
  action: (requestId: string) => Promise<ResultatRetrait>;
  libelle: string;
}) {
  const t = useTranslations("cles");
  const avis = useTranslations("avis");
  const router = useRouter();
  const [resultat, setResultat] = useState<ResultatRetrait | null>(null);
  const [enCours, demarrer] = useTransition();

  if (resultat?.ok) {
    return (
      <section aria-labelledby={`cle-${requestId}`} className="mt-2 rounded border-2 border-linagora p-4">
        <h3 id={`cle-${requestId}`} className="font-medium">
          {t("nouvelleCle", { alias: resultat.alias })}
        </h3>
        <p className="mt-1">{t("avertissement")}</p>
        <code className="mt-2 block rounded bg-neutral-100 p-2 break-all">{resultat.cle}</code>
        <div className="flex flex-wrap gap-3">
          <BoutonCopier texte={resultat.cle} libelle={t("copier")} libelleCopie={t("copiee")} />
          <button
            type="button"
            className="border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100"
            onClick={() => {
              setResultat(null);
              router.refresh();
            }}
          >
            {t("jaiCopie")}
          </button>
        </div>
      </section>
    );
  }
  return (
    <div>
      <button type="button" disabled={enCours} onClick={() => demarrer(async () => setResultat(await action(requestId)))}>
        {enCours ? t("generation") : libelle}
      </button>
      {resultat && !resultat.ok && (
        <p role="alert" className="mt-2 text-red-800">
          {avis.has(`erreurs.${resultat.erreur}`)
            ? avis(`erreurs.${resultat.erreur}`, { objet: "", cas: "", modele: "", equipe: "", champs: "", controles: "", ...resultat.details })
            : avis("erreurs.inconnue")}
        </p>
      )}
    </div>
  );
}
