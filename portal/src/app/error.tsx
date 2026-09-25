"use client";

import { useTranslations } from "next-intl";

/** Erreur inattendue d'une page, dans la langue du visiteur ; « Réessayer » relance le rendu de la page. */
export default function Erreur({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("erreur");
  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("message")}</p>
      <button type="button" onClick={() => retry()}>
        {t("reessayer")}
      </button>
    </>
  );
}
