import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Langue } from "@/lib/langue";
import { listOffers } from "@/lib/services/offers";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../../components";
import { PastillesClassification } from "../pastilles-classification";

/**
 * Spécification #51, ticket #53 : les offres d'abonnement du catalogue, à part des niveaux, avec leur fournisseur, leur
 * prix mensuel TTC, les pastilles de leur niveau maximal et leurs règles d'usage dans la langue du salarié.
 */
export default async function AbonnementsPage(props: PageProps<"/catalogue/abonnements">) {
  await requireUser();
  const [{ euros }, t, domaine, langue, searchParams] = await Promise.all([
    formats(),
    getTranslations("catalogue.abonnements"),
    getTranslations("domaine"),
    getLocale() as Promise<Langue>,
    props.searchParams,
  ]);
  const offres = await listOffers(getDeps(), langue);

  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("introduction")}</p>
      <Notice searchParams={searchParams} />
      {offres.length === 0 ? (
        <p className="mt-4">{t("aucune")}</p>
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {offres.map((o) => (
            <article key={o.id} aria-labelledby={`offre-${o.id}`} className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
              <PastillesClassification level={o.dataLevel} className="mb-2 flex flex-wrap gap-1" />
              <h2 id={`offre-${o.id}`} className="mt-0 mb-0 text-lg">
                {o.name}
              </h2>
              <p className="text-sm text-neutral-600">{o.supplier}</p>
              <p className="mt-2 font-semibold">{t("prix", { prix: euros(o.monthlyPriceEur) })}</p>
              <p className="text-sm">{t("niveau", { niveau: domaine(`niveauxOffre.${o.dataLevel}`) })}</p>
              <h3 className="mt-2.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{t("regles")}</h3>
              <p className="mt-1 text-sm">{o.rules}</p>
              <div className="mt-auto pt-3">
                {o.url && (
                  <p className="text-sm">
                    <a href={o.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                      {t("lienFournisseur", { fournisseur: o.supplier })}
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
                  </p>
                )}
                <p className="mt-2">
                  <Link
                    href={`/demandes/abonnement?offre=${encodeURIComponent(o.id)}`}
                    className="inline-block rounded bg-linagora px-3 py-1.5 text-sm font-medium text-white no-underline hover:bg-linagora-fonce"
                  >
                    {t("demander")}
                  </Link>
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
