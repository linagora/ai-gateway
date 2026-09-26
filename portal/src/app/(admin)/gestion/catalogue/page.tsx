import { ArrowDown } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalogForAdmin } from "@/lib/services/catalog";
import { type AdminOffer, libelleOffre, listOffersForAdmin } from "@/lib/services/offers";
import { getDeps, requireAdminPage } from "@/lib/session";
import { USE_CASES } from "@/lib/use-cases";
import { enregistrerOffreAction, saveCatalogEntryAction } from "../../../actions";
import { ExplicationObligatoires, formats, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";
import { AdminNav } from "../admin-nav";

/**
 * F-50, ticket #6 : fiche de chaque modèle (textes en deux langues, cas d'usage, recommandations) et faits techniques ;
 * puis les offres d'abonnement (spécification #51, ticket #53).
 */
export default async function AdminCataloguePage(props: PageProps<"/gestion/catalogue">) {
  const admin = await requireAdminPage();
  const [{ euros, nombre }, t, o, domaine] = await Promise.all([
    formats(),
    getTranslations("gestionCatalogue"),
    getTranslations("gestionCatalogue.offres"),
    getTranslations("domaine"),
  ]);
  const searchParams = await props.searchParams;
  const [models, offres] = await Promise.all([listCatalogForAdmin(getDeps(), admin), listOffersForAdmin(getDeps(), admin)]);

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
      <p className="text-sm">
        <Link href="#offres" className="inline-flex items-center gap-1">
          <ArrowDown aria-hidden="true" className="size-4" />
          {o("titre")}
        </Link>
      </p>
      <ExplicationObligatoires />
      <Notice searchParams={searchParams} />
      {models.map((m) => (
        <section key={m.modelName} className="mt-6 border-t pt-4">
          <h2 className="mt-0">{m.entry?.displayNameFr ?? m.modelName}</h2>
          <p>
            <code>{m.modelName}</code>
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 text-sm" aria-label={t("faits")}>
            <dt className="font-medium">{t("editeur")}</dt>
            <dd>{m.publisher ?? domaine("nonRenseigne")}</dd>
            <dt className="font-medium">{t("fournisseur")}</dt>
            <dd>{m.supplier ?? domaine("nonRenseigne")}</dd>
            <dt className="font-medium">{t("hebergeurs")}</dt>
            <dd>{m.hosts.join(", ") || domaine("nonRenseigne")}</dd>
            <dt className="font-medium">{t("zone")}</dt>
            <dd>{m.executionRegion ? domaine(`zones.${m.executionRegion}`) : domaine("nonRenseigne")}</dd>
            <dt className="font-medium">{t("prix")}</dt>
            <dd>
              {m.hasEuroPricing && m.inputPricePerMillion !== null && m.outputPricePerMillion !== null
                ? `${euros(m.inputPricePerMillion)} / ${euros(m.outputPricePerMillion)}`
                : t("sansTarif")}
            </dd>
            <dt className="font-medium">{t("contexte")}</dt>
            <dd>{m.maxInputTokens ? t("jetons", { nombre: nombre(m.maxInputTokens) }) : domaine("nonRenseigne")}</dd>
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

      <section aria-labelledby="offres" className="mt-10 border-t pt-4">
        <h2 id="offres">{o("titre")}</h2>
        <p className="text-sm text-neutral-600">{o("introduction")}</p>
        {offres.length === 0 && <p>{o("aucune")}</p>}
        {offres.map((offre) => (
          <article key={offre.id} aria-labelledby={`offre-${offre.id}`} className="mt-4 border-t pt-3">
            <h3 id={`offre-${offre.id}`} className="mt-0">
              {libelleOffre(offre)}
              {!offre.visible && <span className="ml-2 text-sm font-normal text-neutral-500">({o("masquee")})</span>}
            </h3>
            <FormulaireOffre offre={offre} />
          </article>
        ))}
        <h3 className="mt-6">{o("nouvelle")}</h3>
        <FormulaireOffre />
      </section>
    </>
  );
}

/** Formulaire d'une offre d'abonnement : modification d'une offre existante, ou création sans `offre`. */
async function FormulaireOffre({ offre }: { offre?: AdminOffer }) {
  const [o, domaine] = await Promise.all([getTranslations("gestionCatalogue.offres"), getTranslations("domaine")]);
  return (
    <form action={enregistrerOffreAction} aria-label={offre ? libelleOffre(offre) : o("nouvelle")}>
      {offre && <input type="hidden" name="id" value={offre.id} />}
      <div className="grid gap-x-6 md:grid-cols-2">
        <label>
          {o("fournisseur")}
          <Obligatoire />
          <input name="supplier" required defaultValue={offre?.supplier} />
        </label>
        <label>
          {o("nom")}
          <Obligatoire />
          <input name="name" required defaultValue={offre?.name} />
        </label>
        <label>
          {o("prix")}
          <Obligatoire />
          <input name="monthlyPriceEur" type="number" min="0.01" step="0.01" required defaultValue={offre?.monthlyPriceEur} />
        </label>
        <label>
          {o("niveau")}
          <select name="dataLevel" defaultValue={offre?.dataLevel ?? "N1"}>
            {DATA_LEVELS.map((l) => (
              <option key={l} value={l}>
                {domaine(`niveauxOffre.${l}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {o("reglesFr")}
          <Obligatoire />
          <textarea name="rulesFr" required rows={2} defaultValue={offre?.rulesFr} />
        </label>
        <label>
          {o("reglesEn")}
          <textarea name="rulesEn" rows={2} defaultValue={offre?.rulesEn ?? ""} />
        </label>
        <label>
          {o("lien")}
          <input name="url" type="url" defaultValue={offre?.url ?? ""} />
        </label>
      </div>
      <label className="font-normal">
        <input type="checkbox" name="visible" defaultChecked={offre?.visible ?? true} /> {o("visible")}
      </label>
      <button type="submit">{offre ? o("enregistrer") : o("creer")}</button>
    </form>
  );
}
