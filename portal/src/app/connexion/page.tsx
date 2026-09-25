import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { connexionAction } from "../actions";

/** F-01 : page de connexion du portail, traduite ; elle mène au SSO LemonLDAP::NG, et à rien d'autre. */
export default async function ConnexionPage(props: PageProps<"/connexion">) {
  const [t, searchParams, user] = await Promise.all([getTranslations("connexion"), props.searchParams, getCurrentUser()]);
  if (user) redirect("/");
  const retour = typeof searchParams.callbackUrl === "string" ? searchParams.callbackUrl : "/";
  return (
    <section className="mx-auto max-w-lg">
      <h1>{t("titre")}</h1>
      <p>{t("explication")}</p>
      {searchParams.error && (
        <p role="alert" className="mt-4 text-red-800">
          {t("echec")}
        </p>
      )}
      <form action={connexionAction}>
        <input type="hidden" name="callbackUrl" value={retour} />
        <button type="submit">{t("bouton")}</button>
      </form>
    </section>
  );
}
