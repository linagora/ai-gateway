import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/session";

export default async function HomePage() {
  const [user, t] = await Promise.all([requireUser(), getTranslations("accueil")]);
  return (
    <>
      <h1>{t("bonjour", { nom: user.name })}</h1>
      <p>{t("presentation")}</p>
      <ul className="mt-4 list-disc pl-6">
        <li>
          <Link href="/catalogue">{t("catalogue")}</Link>
        </li>
        <li>
          <Link href="/demandes/nouvelle">{t("demander")}</Link>
        </li>
        <li>
          <Link href="/demandes">{t("suivre")}</Link>
        </li>
        {user.isAdmin && (
          <li>
            <Link href="/gestion/demandes">{t("valider")}</Link>
          </li>
        )}
      </ul>
    </>
  );
}
