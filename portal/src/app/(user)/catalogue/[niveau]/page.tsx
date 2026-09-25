import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CAPABILITIES, type Capability } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
import { levelCriteria, levelFromSegment, levelPageHref, levelSegment, sortParam } from "@/lib/level-routes";
import { LEVEL_SORTS, levelModels, modelDetail, type PriceTier, RECHERCHE_MINIMUM } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { USE_CASES } from "@/lib/use-cases";
import { formats, Notice } from "../../../components";
import { BoutonCopier } from "../../../bouton-copier";
import { exemplesAppel } from "../../../exemples-appel";
import { COULEURS_NIVEAUX } from "../couleurs";
import { BoutonSelection } from "./bouton-selection";
import { FiltrageAutomatique } from "./filtrage-automatique";

/** Icônes des capacités, toujours accompagnées de leur libellé. */
const ICONES: Record<Capability, string> = { images: "🖼️", audio_video: "🎧", raisonnement: "🧠" };
const REPERES: Record<PriceTier, "bas" | "moyen" | "eleve"> = { "€": "bas", "€€": "moyen", "€€€": "eleve" };

/**
 * Tickets #7 à #10 : les modèles d'un niveau, en cartes (lecture cumulative, niveau Expérimental à part),
 * avec recherche, filtres et tri portés par l'adresse, le détail d'un modèle dans un panneau (?modele=),
 * et la sélection de modèles envoyée au formulaire de demande avec le niveau de la page.
 */
export default async function LevelPage(props: PageProps<"/catalogue/[niveau]">) {
  await requireUser();
  const level = levelFromSegment((await props.params).niveau);
  if (!level) notFound();
  const [{ euros, nombre }, t, catalogue, domaine, detailT, language, searchParams] = await Promise.all([
    formats(),
    getTranslations("niveau"),
    getTranslations("catalogue"),
    getTranslations("domaine"),
    getTranslations("detail"),
    getLocale() as Promise<Langue>,
    props.searchParams,
  ]);
  const criteria = levelCriteria(searchParams);
  const modeleOuvert = typeof searchParams.modele === "string" ? searchParams.modele : null;
  const [{ modelCount, models }, detail] = await Promise.all([
    levelModels(getDeps(), { level, language, criteria }),
    modeleOuvert ? modelDetail(getDeps(), { level, modelName: modeleOuvert, language }) : null,
  ]);
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
          <fieldset className="flex flex-col">
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
          {/* Les critères s'appliquent dès qu'ils changent ; la réinitialisation recharge la page pour décocher les cases. */}
          <FiltrageAutomatique minimum={RECHERCHE_MINIMUM} />
          <a href={pageSansCritere}>{t("reinitialiser")}</a>
        </form>
      )}
      {modelCount > 0 && models.length === 0 && <p className="mt-6 italic">{t("aucunResultat")}</p>}
      {models.length > 0 && (
        <form action="/demandes/nouvelle" method="get" className="mt-6">
          <input type="hidden" name="niveau" value={level} />
          <p className="text-right">
            <BoutonSelection />
          </p>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {models.map((m, index) => (
              <article key={m.modelName} aria-labelledby={`modele-${index}`} className="flex flex-col gap-2 rounded border border-neutral-300 p-4">
                <h2 id={`modele-${index}`} className="my-0">
                  <Link href={levelPageHref(level, searchParams, m.modelName)} scroll={false}>
                    {m.displayName}
                  </Link>
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
                  <p className={`self-start rounded border-2 px-2 text-sm ${COULEURS_NIVEAUX[m.acceptsUpTo]}`}>{t("accepteJusqua", { niveau: m.acceptsUpTo })}</p>
                )}
                <p className="line-clamp-2" title={m.shortDescription}>
                  {m.shortDescription}
                </p>
                {m.capabilities.length > 0 && (
                  <ul aria-label={t("capacites")} className="flex flex-wrap gap-x-3 text-sm">
                    {m.capabilities.map((c) => (
                      <li key={c}>
                        <span aria-hidden="true">{ICONES[c]}</span> {domaine(`capacites.${c}`)}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  <span className="sr-only">{t(`repere.${REPERES[m.priceTier]}`)} : </span>
                  <span aria-hidden="true" title={t(`repere.${REPERES[m.priceTier]}`)} className="text-lg font-semibold">
                    {m.priceTier}
                  </span>
                  <span className="text-xs text-neutral-600">
                    {" · "}
                    {t("prix", { entree: euros(m.inputPricePerMillion), sortie: euros(m.outputPricePerMillion) })}
                  </span>
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
                <label className="mt-auto pt-2 font-normal">
                  <input type="checkbox" name="modeles" value={m.modelName} aria-label={t("selectionnerModele", { nom: m.displayName })} />{" "}
                  {t("selectionner")}
                </label>
              </article>
            ))}
          </div>
        </form>
      )}
      {detail && (
        <aside
          role="dialog"
          aria-labelledby="detail-titre"
          className="fixed inset-y-0 right-0 z-10 flex w-full max-w-lg flex-col gap-2 overflow-y-auto border-l border-neutral-300 bg-white p-6 shadow-xl"
        >
          <p className="text-right">
            <Link href={levelPageHref(level, searchParams, null)} scroll={false}>
              <span aria-hidden="true">✕ </span>
              {detailT("fermer")}
            </Link>
          </p>
          <h2 id="detail-titre" className="my-0">
            {detail.displayName}
          </h2>
          <p className="text-sm">
            {detail.publisher ?? "—"} · {detail.executionRegion ? domaine(`zones.${detail.executionRegion}`) : "—"}
          </p>
          <code className="text-xs break-all text-neutral-600">{detail.modelName}</code>
          {detail.acceptsUpTo && (
            <p className={`self-start rounded border-2 px-2 text-sm ${COULEURS_NIVEAUX[detail.acceptsUpTo]}`}>{t("accepteJusqua", { niveau: detail.acceptsUpTo })}</p>
          )}
          <h3 className="mt-3 font-medium">{detailT("description")}</h3>
          <p className="whitespace-pre-line">{detail.longDescription}</p>
          <h3 className="mt-3 font-medium">{detailT("hebergeurs")}</h3>
          <p>{detail.hosts.join(", ") || "—"}</p>
          <h3 className="mt-3 font-medium">{detailT("limites")}</h3>
          <p className="whitespace-pre-line">{detail.limitations ?? detailT("aucuneLimite")}</p>
          {detail.apiKind === "decision" && (
            <>
              <h3 className="mt-3 font-medium">{detailT("apiDecision.titre")}</h3>
              <p>{detailT("apiDecision.explication")}</p>
            </>
          )}
          <h3 className="mt-3 font-medium">{detailT("exempleAppel")}</h3>
          {(() => {
            const exemple = exemplesAppel(detail.modelName, detail.apiKind, {
              message: detailT("exemple.message"),
              etat: detailT("exemple.etat"),
              question: detailT("exemple.question"),
            }).curl;
            return (
              <>
                <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                  <code>{exemple}</code>
                </pre>
                <div>
                  <BoutonCopier texte={exemple} libelle={detailT("copier")} libelleCopie={detailT("copie")} />
                </div>
              </>
            );
          })()}
        </aside>
      )}
    </>
  );
}
