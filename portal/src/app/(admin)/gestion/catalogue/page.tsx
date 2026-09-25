import { getTranslations } from "next-intl/server";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalogForAdmin } from "@/lib/services/catalog";
import { getDeps, requireAdminPage } from "@/lib/session";
import { USE_CASES } from "@/lib/use-cases";
import { saveCatalogEntryAction } from "../../../actions";
import { ExplicationObligatoires, formats, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";
import { AdminNav } from "../admin-nav";

/** F-50, ticket #6 : fiche de chaque modèle (textes en deux langues, cas d'usage, recommandations) et faits techniques. */
export default async function AdminCataloguePage(props: PageProps<"/gestion/catalogue">) {
  const admin = await requireAdminPage();
  const [{ euros, nombre }, t, domaine] = await Promise.all([formats(), getTranslations("gestionCatalogue"), getTranslations("domaine")]);
  const searchParams = await props.searchParams;
  const models = await listCatalogForAdmin(getDeps(), admin);

  const textes: [champ: string, libelle: string, lignes: number, obligatoire: boolean][] = [
    ["displayName", "nom", 0, true],
    ["shortDescription", "courte", 2, true],
    ["longDescription", "longue", 4, true],
    ["limitations", "limites", 2, false],
  ];

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">{t("introduction")}</p>
      {models.length > 0 && <ExplicationObligatoires />}
      <Notice searchParams={searchParams} />
      {models.map((m) => (
        <section key={m.modelName} className="mt-6 border-t pt-4">
          <h2 className="mt-0">{m.entry?.displayNameFr ?? m.modelName}</h2>
          <p>
            <code>{m.modelName}</code>
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 text-sm" aria-label={t("faits")}>
            <dt className="font-medium">{t("editeur")}</dt>
            <dd>{m.publisher ?? "—"}</dd>
            <dt className="font-medium">{t("fournisseur")}</dt>
            <dd>{m.supplier ?? "—"}</dd>
            <dt className="font-medium">{t("hebergeurs")}</dt>
            <dd>{m.hosts.join(", ") || "—"}</dd>
            <dt className="font-medium">{t("zone")}</dt>
            <dd>{m.executionRegion ? domaine(`zones.${m.executionRegion}`) : "—"}</dd>
            <dt className="font-medium">{t("prix")}</dt>
            <dd>{m.hasEuroPricing ? `${euros(m.inputPricePerMillion)} / ${euros(m.outputPricePerMillion)}` : t("sansTarif")}</dd>
            <dt className="font-medium">{t("contexte")}</dt>
            <dd>{m.maxInputTokens ? t("jetons", { nombre: nombre(m.maxInputTokens) }) : "—"}</dd>
            <dt className="font-medium">{t("capacites")}</dt>
            <dd>{m.capabilities.map((c) => domaine(`capacites.${c}`)).join(", ") || t("aucune")}</dd>
          </dl>
          <form action={saveCatalogEntryAction}>
            <input type="hidden" name="modelName" value={m.modelName} />
            <div className="grid gap-x-6 md:grid-cols-2">
              {textes.flatMap(([champ, libelle, lignes, obligatoire]) =>
                (["Fr", "En"] as const).map((langue) => {
                  const nom = `${champ}${langue}`;
                  const valeur = (m.entry?.[nom as keyof typeof m.entry] as string | null | undefined) ?? (nom === "displayNameFr" ? m.modelName : "");
                  const requis = obligatoire && langue === "Fr";
                  return (
                    <label key={nom}>
                      {t(`${libelle}${langue}`)}
                      {requis && <Obligatoire />}
                      {lignes === 0 ? (
                        <input name={nom} required={requis} defaultValue={valeur} />
                      ) : (
                        <textarea name={nom} required={requis} rows={lignes} defaultValue={valeur} />
                      )}
                    </label>
                  );
                }),
              )}
            </div>
            {(["useCases", "recommendedFor"] as const).map((groupe) => (
              <fieldset key={groupe}>
                <legend className="font-medium">{t(groupe === "useCases" ? "casUsage" : "recommandePour")}</legend>
                <div className="flex flex-wrap gap-x-4">
                  {USE_CASES.map((u) => (
                    <label key={u} className="font-normal">
                      <input type="checkbox" name={groupe} value={u} defaultChecked={m.entry?.[groupe]?.includes(u) ?? false} /> {domaine(`casUsage.${u}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <label>
              {t("niveau")}
              <select name="dataLevel" defaultValue={m.entry?.dataLevel ?? "N1"}>
                {DATA_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {domaine(`niveaux.${l}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="font-normal">
              <input type="checkbox" name="visible" defaultChecked={m.entry?.visible ?? false} /> {t("visible")}
            </label>
            <button type="submit">{t("enregistrer")}</button>
          </form>
        </section>
      ))}
      {models.length === 0 && <p>{t("aucunModele")}</p>}
    </>
  );
}
