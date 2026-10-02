import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import type { Langue } from "@/lib/langue";
import type { DataLevel } from "@/lib/policy";
import { type CatalogOffer, listOffers } from "@/lib/services/offers";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../../components";
import { PastillesClassification } from "../../../pastilles-classification";
import { ChoixOffre } from "./choix-offre";
import { LogoFournisseur } from "./logo-fournisseur";

/**
 * Spécification #51, ticket #53 : les offres d'abonnement du catalogue, présentées par fournisseur (retours de
 * l'utilisateur du 2026-09-26) : son logo, puis une liste de ses offres, dont celle choisie montre son prix mensuel
 * TTC, les pastilles de son niveau maximal et ses règles d'usage dans la langue du salarié. Un rappel dit que
 * l'abonnement reste l'exception, derrière les modèles de la passerelle.
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
  // Offres déjà triées par fournisseur, puis par prix croissant : l'ordre se garde dans chaque groupe.
  const parFournisseur = new Map<string, CatalogOffer[]>();
  for (const offre of offres) parFournisseur.set(offre.supplier, [...(parFournisseur.get(offre.supplier) ?? []), offre]);
  const niveaux = [...new Set(offres.map((o) => o.dataLevel))];
  const pastilles: Partial<Record<DataLevel, ReactNode>> = Object.fromEntries(
    niveaux.map((niveau) => [niveau, <PastillesClassification key={niveau} level={niveau} className="flex flex-wrap gap-1" />]),
  );

  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("introduction")}</p>
      <p className="mt-3 rounded border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm">
        {t("reserve")}{" "}
        <Link href="/catalogue" className="font-medium">
          {t("lienPasserelle")}
          {/* Flèche dans le texte, liée au dernier mot par une espace insécable. */}
          {" "}
          <ArrowRight aria-hidden="true" className="inline size-3.5 align-[-0.125em]" />
        </Link>
      </p>
      <Notice searchParams={searchParams} />
      {offres.length === 0 ? (
        <p className="mt-4">{t("aucune")}</p>
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[...parFournisseur].map(([fournisseur, offresDuFournisseur], i) => (
            <section
              key={fournisseur}
              aria-labelledby={`fournisseur-${i}`}
              className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center gap-3">
                <LogoFournisseur fournisseur={fournisseur} />
                <div>
                  <h2 id={`fournisseur-${i}`} className="mt-0 mb-0 text-lg">
                    {fournisseur}
                  </h2>
                  <p className="text-sm text-neutral-600">{t("nombreOffres", { nombre: offresDuFournisseur.length })}</p>
                </div>
              </div>
              <ChoixOffre
                offres={offresDuFournisseur.map((o) => ({
                  id: o.id,
                  option: `${o.name} · ${euros(o.monthlyPriceEur)}`,
                  prix: t("prix", { prix: euros(o.monthlyPriceEur) }),
                  niveau: o.dataLevel,
                  libelleNiveau: t("niveau", { niveau: domaine(`niveauxOffre.${o.dataLevel}`) }),
                  regles: o.rules,
                  url: o.url,
                }))}
                pastilles={pastilles}
                libelles={{
                  offre: t("offre"),
                  regles: t("regles"),
                  lienFournisseur: t("lienFournisseur", { fournisseur }),
                  demander: t("demander"),
                }}
              />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
