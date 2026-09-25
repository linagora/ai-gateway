import { getTranslations } from "next-intl/server";
import { readSettings } from "@/lib/services/settings";
import { getDeps, requireAdminPage } from "@/lib/session";
import { saveSettingsAction } from "../../../actions";
import { Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

const FIELDS = ["default_budget", "default_budget_duration", "default_days", "default_rpm", "default_tpm", "pickup_days"] as const;

/** F-51 : valeurs par défaut des clés ; aucune valeur n'est codée en dur. */
export default async function SettingsPage(props: PageProps<"/gestion/parametres">) {
  await requireAdminPage();
  const [t, searchParams] = await Promise.all([getTranslations("gestion.parametres"), props.searchParams]);
  const settings = await readSettings(getDeps().db);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      <p>{t("explication")}</p>
      <form action={saveSettingsAction}>
        {FIELDS.map((key) => (
          <label key={key}>
            {t(`champs.${key}`)}
            <input name={key} defaultValue={settings[key] ?? ""} />
          </label>
        ))}
        <button type="submit">{t("enregistrer")}</button>
      </form>
    </>
  );
}
