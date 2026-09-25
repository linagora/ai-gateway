import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CAPABILITIES, type Capability } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
import { levelCriteria, levelFromSegment, levelSegment, sortParam } from "@/lib/level-routes";
import { LEVEL_SORTS, levelModels, type PriceTier } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { USE_CASES } from "@/lib/use-cases";
import { formats, Notice } from "../../../components";
import { COULEURS_NIVEAUX } from "../couleurs";

/** Icônes des capacités, toujours accompagnées de leur libellé. */
const ICONES: Record<Capability, string> = { images: "🖼️", audio_video: "🎧", raisonnement: "🧠" };
const REPERES: Record<PriceTier, "bas" | "moyen" | "eleve"> = { "€": "bas", "€€": "moyen", "€€€": "eleve" };

/**
 * Tickets #7 et #8 : les modèles d'un niveau, en cartes (lecture cumulative, niveau Expérimental à part),
 * avec recherche, filtres et tri portés par l'adresse.
 */
export default async function LevelPage(props: PageProps<"/catalogue/[niveau]">) {
  await requireUser();
  const level = levelFromSegment((await props.params).niveau);
  if (!level) notFound();
  const [{ euros, nombre }, t, catalogue, domaine, language, searchParams] = await Promise.all([
    formats(),
    getTranslations("niveau"),
    getTranslations("catalogue"),
    getTranslations("domaine"),
    getLocale() as Promise<Langue>,
    props.searchParams,
  ]);
  const criteria = levelCriteria(searchParams);
  const { modelCount, models } = await levelModels(getDeps(), { level, language, criteria });
  const pageSansCritere = `/catalogue/${levelSegment(level)}`;

  return (
    <>
      <p>
        <Link href="/catalogue">{t("tousLesNiveaux")}</Link>
      </p>
      <header className={`mt-2 border-l-8 pl-4 ${COULEURS_NIVEAUX[level]}`}>
        <h1 className="mb-1">{domaine(`niveaux.${level}`)}</h1>
        <p>{catalogue(`niveaux.${level}.definition`)}</p>
      </header>
      <Notice searchParams={searchParams} />
      {modelCount === 0 ? (
        <p className="mt-6 italic">{catalogue("aucunModele")}</p>
      ) : (
        <form method="get" role="search" aria-label={t("filtres")} className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-2">
          <label>
            {t("recherche")}
            <input type="search" name="q" defaultValue={criteria.search} />
          </label>
          <label>
            {t("casUsage")}
            <select name="cas" defaultValue={criteria.useCase ?? ""}>
              <option value="">{t("tousCasUsage")}</option>
              {USE_CASES.map((u) => (
                <option key={u} value={u}>
                  {domaine(`casUsage.${u}`)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-wrap gap-x-4">
            <legend className="font-medium">{t("capacites")}</legend>
            {CAPABILITIES.map((c) => (
              <label key={c} className="mt-0 font-normal">
                <input type="checkbox" name="capacite" value={c} defaultChecked={criteria.capabilities?.includes(c)} /> <span aria-hidden="true">{ICONES[c]}</span>{" "}
                {domaine(`capacites.${c}`)}
              </label>
            ))}
          </fieldset>
          <label className="font-normal">
            <input type="checkbox" name="ue" value="1" defaultChecked={criteria.euOnly} /> {t("ueUniquement")}
          </label>
          <label>
            {t("tri")}
            <select name="tri" defaultValue={sortParam(criteria.sort ?? "recommended")}>
              {LEVEL_SORTS.map((s) => (
                <option key={s} value={sortParam(s)}>
                  {t(`tris.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">{t("filtrer")}</button>
          <Link href={pageSansCritere}>{t("reinitialiser")}</Link>
        </form>
      )}
      {modelCount > 0 && models.length === 0 && <p className="mt-6 italic">{t("aucunResultat")}</p>}
      {models.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {models.map((m, index) => (
            <article key={m.modelName} aria-labelledby={`modele-${index}`} className="flex flex-col gap-2 rounded border border-neutral-300 p-4">
              <h2 id={`modele-${index}`} className="my-0">
                {m.displayName}
              </h2>
              <p className="text-sm">
                {m.publisher ?? "—"} · {m.executionRegion ? domaine(`zones.${m.executionRegion}`) : "—"}
              </p>
              <code className="text-xs break-all text-neutral-600">{m.modelName}</code>
              {m.recommendedFor.length > 0 && (
                <p className="self-start rounded bg-amber-100 px-2 text-sm font-medium">
                  <span aria-hidden="true">★ </span>
                  {t("notreChoix", { cas: m.recommendedFor.map((u) => domaine(`casUsage.${u}`)).join(", ") })}
                </p>
              )}
              {m.acceptsUpTo && (
                <p className="self-start rounded border border-neutral-400 px-2 text-sm">{t("accepteJusqua", { niveau: m.acceptsUpTo })}</p>
              )}
              <p>{m.shortDescription}</p>
              {m.capabilities.length > 0 && (
                <ul aria-label={t("capacites")} className="flex flex-wrap gap-x-3 text-sm">
                  {m.capabilities.map((c) => (
                    <li key={c}>
                      <span aria-hidden="true">{ICONES[c]}</span> {domaine(`capacites.${c}`)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm">
                <span className="sr-only">{t(`repere.${REPERES[m.priceTier]}`)} : </span>
                <span aria-hidden="true" title={t(`repere.${REPERES[m.priceTier]}`)} className="font-semibold">
                  {m.priceTier}
                </span>
                {" · "}
                {t("prix", { entree: euros(m.inputPricePerMillion), sortie: euros(m.outputPricePerMillion) })}
              </p>
              <p className="text-sm">
                {m.context ? (
                  <span title={t("hypothesePages")}>
                    {t("contexte", { jetons: nombre(m.context.tokens), pages: nombre(m.context.pages) })} <span aria-hidden="true">ⓘ</span>
                  </span>
                ) : (
                  t("contexteInconnu")
                )}
              </p>
              {m.useCases.length > 0 && (
                <ul aria-label={t("casUsage")} className="flex flex-wrap gap-2 text-sm">
                  {m.useCases.map((u) => (
                    <li key={u} className="rounded bg-neutral-100 px-2">
                      {domaine(`casUsage.${u}`)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-auto pt-2">
                <Link href={`/demandes/nouvelle?niveau=${level}&modele=${encodeURIComponent(m.modelName)}`}>{t("demanderCle")}</Link>
              </p>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
