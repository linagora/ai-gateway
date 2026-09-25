import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** Adresse inconnue (ou niveau, ou demande, qui n'existe pas), dans la langue du visiteur. */
export default async function NotFound() {
  const t = await getTranslations("introuvable");
  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("message")}</p>
      <p>
        <Link href="/">{t("retour")}</Link>
      </p>
    </>
  );
}
