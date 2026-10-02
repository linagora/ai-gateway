import { ArrowRight, Check, X } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { levelSegment } from "@/lib/level-routes";
import { levelOverview } from "@/lib/services/catalog";
import { listOffers } from "@/lib/services/offers";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../components";
import { PastillesClassification } from "../../pastilles-classification";
import { BORDURES_GAUCHES_NIVEAUX } from "./couleurs";

/** Intitulé discret d'une rubrique de carte. */
const RUBRIQUE = "mt-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500";

/** Texte d'une carte, un peu plus petit que le texte courant pour que les pastilles tiennent sans défilement. */
const TEXTE = "text-[13px] leading-snug";

/** Pictogramme en tête d'une ligne de liste, aligné sur sa première ligne de texte. */
const PUCE = "mt-0.5 size-3.5 shrink-0";

/**
 * Ticket #5 : vue d'ensemble des niveaux de confidentialité, point d'entrée du catalogue. Les quatre cartes tiennent
 * sur une rangée et sans défilement sur un écran d'ordinateur (retours de recette du 2026-09-25). En tête, les deux voies
 * (retours du 2026-09-26) : les modèles de la passerelle, solution privilégiée, et l'abonnement individuel, sur
 * justification ; texte serré pour que les cartes tiennent toujours à l'écran.
 */
export default async function CataloguePage(props: PageProps<"/catalogue">) {
  await requireUser();
  const [{ euros }, t, domaine, niveaux, offres, searchParams] = await Promise.all([
    formats(),
    getTranslations("catalogue"),
    getTranslations("domaine"),
    levelOverview(getDeps()),
    listOffers(getDeps()),
    props.searchParams,
  ]);

  return (
    <>
      <h1 className="mb-2">{t("titre")}</h1>
      <div className="grid gap-x-6 gap-y-2 text-[13px] leading-snug md:grid-cols-2">
        <p className="border-l-4 border-linagora pl-3">{t.rich("voies.passerelle", { fort: (texte) => <strong>{texte}</strong> })}</p>
        {offres.length > 0 && (
          <p className="border-l-4 border-neutral-300 pl-3">
            {t.rich("voies.abonnement", { fort: (texte) => <strong>{texte}</strong> })}{" "}
            <Link href="/catalogue/abonnements" className="font-medium text-linagora no-underline hover:underline">
              {t("voies.lienAbonnements")}
              {" "}
              <ArrowRight aria-hidden="true" className="inline size-3.5 align-[-0.125em]" />
            </Link>
          </p>
        )}
      </div>
      <Notice searchParams={searchParams} />
      <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:-mx-16">
        {niveaux.map(({ level, modelCount, startingPricePerMillion }) => (
          <section
            key={level}
            aria-labelledby={`niveau-${level}`}
            className={`flex flex-col rounded-lg border border-l-[6px] border-neutral-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${BORDURES_GAUCHES_NIVEAUX[level]}`}
          >
            <h2 id={`niveau-${level}`} className="mt-0 mb-1 text-lg">
              {domaine(`niveaux.${level}`)}
            </h2>
            {/* Pastilles centrées au-dessus du nom du niveau, lu en premier ; hauteur fixe pour aligner les noms des cartes. */}
            <PastillesClassification level={level} className="order-first mb-2 flex h-[68px] flex-col items-center justify-center gap-1" />
            <p className={`${TEXTE} text-neutral-600`}>{t(`niveaux.${level}.definition`)}</p>
            <h3 className={RUBRIQUE}>{t("confier")}</h3>
            <ul className={`mt-1 space-y-0.5 ${TEXTE}`}>
              {(t.raw(`niveaux.${level}.confier`) as string[]).map((exemple) => (
                <li key={exemple} className="flex gap-2">
                  <Check aria-hidden="true" strokeWidth={2.5} className={`${PUCE} text-green-700`} />
                  <span>{exemple}</span>
                </li>
              ))}
            </ul>
            <h3 className={RUBRIQUE}>{t("jamais")}</h3>
            <ul className={`mt-1 space-y-0.5 ${TEXTE}`}>
              {(t.raw(`niveaux.${level}.jamais`) as string[]).map((exemple) => (
                <li key={exemple} className="flex gap-2">
                  <X aria-hidden="true" strokeWidth={2.5} className={`${PUCE} text-red-700`} />
                  <span>{exemple}</span>
                </li>
              ))}
            </ul>
            <h3 className={RUBRIQUE}>{t("garanties")}</h3>
            <p className="mt-1 rounded-md bg-neutral-50 p-2 text-xs leading-snug text-neutral-700">{t(`niveaux.${level}.garanties`)}</p>
            <div className="mt-auto pt-3">
              {modelCount === 0 ? (
                <p className={`${TEXTE} italic`}>{t("aucunModele")}</p>
              ) : (
                <p className={`${TEXTE} font-semibold`}>
                  {t("modeles", { nombre: modelCount })}
                  {startingPricePerMillion !== null && ` · ${t("prixDepart", { prix: euros(startingPricePerMillion) })}`}
                </p>
              )}
              <p className="mt-2">
                <Link
                  href={`/catalogue/${levelSegment(level)}`}
                  className="inline-block rounded bg-linagora px-3 py-1.5 text-sm font-medium text-white no-underline hover:bg-linagora-fonce"
                >
                  {t("voirModeles")}
                </Link>
              </p>
              <p className="mt-2 text-sm">
                <Link href={`/demandes/nouvelle?niveau=${level}`} className="font-medium text-linagora no-underline hover:underline">
                  {t("demanderCle")}
                  {/* Flèche dans le texte, liée au dernier mot par une espace insécable. */}
                  {" "}
                  <ArrowRight aria-hidden="true" className="inline size-3.5 align-[-0.125em]" />
                </Link>
              </p>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
