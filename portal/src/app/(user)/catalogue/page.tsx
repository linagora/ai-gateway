import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { levelSegment } from "@/lib/level-routes";
import { levelOverview } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../components";

/** Couleur d'un niveau, toujours accompagnée de son nom (jamais la couleur seule). */
const COULEURS = { N1: "border-green-700", N2: "border-amber-700", N3: "border-red-700", EXP: "border-violet-700" } as const;

/** Ticket #5 : vue d'ensemble des niveaux de confidentialité, point d'entrée du catalogue. */
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
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {niveaux.map(({ level, modelCount, startingPricePerMillion }) => (
          <section key={level} aria-labelledby={`niveau-${level}`} className={`rounded border-l-8 border border-neutral-200 p-4 ${COULEURS[level]}`}>
            <h2 id={`niveau-${level}`} className="mt-0">
              {domaine(`niveaux.${level}`)}
            </h2>
            <p>{t(`niveaux.${level}.definition`)}</p>
            <h3 className="mt-3 font-medium">{t("confier")}</h3>
            <ul className="list-disc pl-6">
              {(t.raw(`niveaux.${level}.confier`) as string[]).map((exemple) => (
                <li key={exemple}>{exemple}</li>
              ))}
            </ul>
            <h3 className="mt-3 font-medium">{t("jamais")}</h3>
            <ul className="list-disc pl-6">
              {(t.raw(`niveaux.${level}.jamais`) as string[]).map((exemple) => (
                <li key={exemple}>{exemple}</li>
              ))}
            </ul>
            <h3 className="mt-3 font-medium">{t("garanties")}</h3>
            <p>{t(`niveaux.${level}.garanties`)}</p>
            {modelCount === 0 ? (
              <p className="mt-3 italic">{t("aucunModele")}</p>
            ) : (
              <p className="mt-3 font-medium">
                {t("modeles", { nombre: modelCount })}
                {startingPricePerMillion !== null && ` · ${t("prixDepart", { prix: euros(startingPricePerMillion) })}`}
              </p>
            )}
            <p className="mt-3 flex flex-wrap gap-4">
              <Link href={`/catalogue/${levelSegment(level)}`}>{t("voirModeles")}</Link>
              <Link href={`/demandes/nouvelle?niveau=${level}`}>{t("demanderCle")}</Link>
            </p>
          </section>
        ))}
      </div>
    </>
  );
}
