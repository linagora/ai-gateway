import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { levelSegment } from "@/lib/level-routes";
import { levelOverview } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../components";
import { BORDURES_GAUCHES_NIVEAUX } from "./couleurs";

/** Intitulé discret d'une rubrique de carte. */
const RUBRIQUE = "mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500";

/**
 * Ticket #5 : vue d'ensemble des niveaux de confidentialité, point d'entrée du catalogue. Les quatre cartes tiennent
 * sur une rangée et sans défilement sur un écran d'ordinateur (retours de recette du 2026-09-25).
 */
export default async function CataloguePage(props: PageProps<"/catalogue">) {
  await requireUser();
  const [{ euros }, t, domaine, niveaux, searchParams] = await Promise.all([
    formats(),
    getTranslations("catalogue"),
    getTranslations("domaine"),
    levelOverview(getDeps()),
    props.searchParams,
  ]);

  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("introduction")}</p>
      <Notice searchParams={searchParams} />
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:-mx-16">
        {niveaux.map(({ level, modelCount, startingPricePerMillion }) => (
          <section
            key={level}
            aria-labelledby={`niveau-${level}`}
            className={`flex flex-col rounded-lg border border-l-[6px] border-neutral-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${BORDURES_GAUCHES_NIVEAUX[level]}`}
          >
            <h2 id={`niveau-${level}`} className="mt-0 mb-1 text-lg">
              {domaine(`niveaux.${level}`)}
            </h2>
            <p className="text-sm text-neutral-600">{t(`niveaux.${level}.definition`)}</p>
            <h3 className={RUBRIQUE}>{t("confier")}</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {(t.raw(`niveaux.${level}.confier`) as string[]).map((exemple) => (
                <li key={exemple} className="flex gap-2">
                  <span aria-hidden="true" className="text-green-700">
                    ✓
                  </span>
                  <span>{exemple}</span>
                </li>
              ))}
            </ul>
            <h3 className={RUBRIQUE}>{t("jamais")}</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {(t.raw(`niveaux.${level}.jamais`) as string[]).map((exemple) => (
                <li key={exemple} className="flex gap-2">
                  <span aria-hidden="true" className="text-red-700">
                    ✕
                  </span>
                  <span>{exemple}</span>
                </li>
              ))}
            </ul>
            <h3 className={RUBRIQUE}>{t("garanties")}</h3>
            <p className="mt-1 rounded-md bg-neutral-50 p-2 text-xs leading-relaxed text-neutral-700">{t(`niveaux.${level}.garanties`)}</p>
            <div className="mt-auto pt-4">
              {modelCount === 0 ? (
                <p className="text-sm italic">{t("aucunModele")}</p>
              ) : (
                <p className="text-sm font-semibold">
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
                  {t("demanderCle")} <span aria-hidden="true">→</span>
                </Link>
              </p>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
