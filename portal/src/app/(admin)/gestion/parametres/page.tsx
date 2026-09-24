import { readSettings } from "@/lib/services/settings";
import { getDeps, requireAdminPage } from "@/lib/session";
import { saveSettingsAction } from "../../../actions";
import { Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

const FIELDS = [
  { key: "default_budget", label: "Budget par défaut (€)" },
  { key: "default_budget_duration", label: "Période du budget (ex. 30d)" },
  { key: "default_days", label: "Durée de validité par défaut (jours)" },
  { key: "default_rpm", label: "Limite de requêtes par minute (facultatif)" },
  { key: "default_tpm", label: "Limite de jetons par minute (facultatif)" },
  { key: "pickup_days", label: "Délai de retrait d'une clé approuvée (jours)" },
] as const;

/** F-51 : valeurs par défaut des clés ; aucune valeur n'est codée en dur. */
export default async function SettingsPage(props: PageProps<"/gestion/parametres">) {
  await requireAdminPage();
  const searchParams = await props.searchParams;
  const settings = await readSettings(getDeps().db);

  return (
    <>
      <AdminNav />
      <h1>Valeurs par défaut des clés</h1>
      <Notice searchParams={searchParams} />
      <p>Elles pré-remplissent le formulaire d&apos;approbation. Un champ laissé vide n&apos;est pas modifié.</p>
      <form action={saveSettingsAction}>
        {FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input name={f.key} defaultValue={settings[f.key] ?? ""} />
          </label>
        ))}
        <button type="submit">Enregistrer</button>
      </form>
    </>
  );
}
