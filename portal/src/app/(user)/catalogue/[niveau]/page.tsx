import { ArrowLeft, ArrowRight, Brain, Headphones, ImageIcon, Info, type LucideIcon, Star, WandSparkles, X } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CAPABILITIES, type Capability, type ExecutionRegion } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
import { levelCriteria, levelFromSegment, levelPageHref, levelSegment, sortParam } from "@/lib/level-routes";
import { LEVEL_SORTS, levelModels, modelDetail, type PriceTier, RECHERCHE_MINIMUM } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { espacesInsecables } from "@/lib/typographie";
import { USE_CASES } from "@/lib/use-cases";
import { formats, Notice } from "../../../components";
import { BoutonCopier } from "../../../bouton-copier";
import { exemplesAppel } from "../../../exemples-appel";
import { FiltrageAutomatique } from "../../../filtrage-automatique";
import { PastillesClassification } from "../../../pastilles-classification";
import { COULEURS_NIVEAUX } from "../couleurs";
import { BoutonSelection } from "./bouton-selection";

/** Pictogrammes des capacités (jeu Lucide, comme le reste du catalogue), toujours accompagnés de leur libellé. */
const ICONES: Record<Capability, LucideIcon> = { images: ImageIcon, generation_images: WandSparkles, audio_video: Headphones, raisonnement: Brain };

/** Pastille d'un fait sur un modèle (recommandation, niveau maximal, cas d'usage), arrondie comme les pastilles de classification. */
const PASTILLE = "self-start rounded-xl px-2.5 text-sm";
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
  const [{ modelCount, apiKinds, models }, detail] = await Promise.all([
    levelModels(getDeps(), { level, language, criteria }),
    modeleOuvert ? modelDetail(getDeps(), { level, modelName: modeleOuvert, language }) : null,
  ]);
  const pageSansCritere = `/catalogue/${levelSegment(level)}`;
  /** « Éditeur · zone d'exécution », sans la partie inconnue. */
  const editeurEtZone = (m: { publisher: string | null; executionRegion: ExecutionRegion | null }) =>
    [m.publisher, m.executionRegion && domaine(`zones.${m.executionRegion}`)].filter(Boolean).join(" · ");

  return (
    <>
      <p>
        <Link href="/catalogue" className="inline-flex items-center gap-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("tousLesNiveaux")}
        </Link>
      </p>
      {/* Même présentation que la carte du niveau dans la vue d'ensemble : couleur, nom, pastilles et définition. */}
      <header className={`mt-2 border-l-8 pl-4 ${COULEURS_NIVEAUX[level]}`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <h1 className="my-0">{domaine(`niveaux.${level}`)}</h1>
          <PastillesClassification level={level} className="flex flex-wrap gap-2" />
        </div>
        <p className="mt-1">{catalogue(`niveaux.${level}.definition`)}</p>
      </header>
      <Notice searchParams={searchParams} />
      {modelCount === 0 ? (
        <p className="mt-6 italic">{catalogue("aucunModele")}</p>
      ) : (
        <form method="get" role="search" aria-label={t("filtres")} className="mt-6">
          {/* Critères alignés sur leur libellé ; tri et réinitialisation en dessous. */}
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
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
            {/* Seuls les types présents sur la page ; avec un seul type, le filtre n'apporterait rien. */}
            {apiKinds.length > 1 && (
              <label>
                {t("typeApi")}
                <select name="type" defaultValue={criteria.apiKind ?? ""}>
                  <option value="">{t("tousTypesApi")}</option>
                  {apiKinds.map((type) => (
                    <option key={type} value={type}>
                      {domaine(`typesApi.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="flex flex-col">
              <legend className="font-medium">{t("capacites")}</legend>
              {CAPABILITIES.map((c) => {
                const Icone = ICONES[c];
                return (
                  <label key={c} className="mt-0 flex items-center gap-1.5 font-normal">
                    <input type="checkbox" name="capacite" value={c} defaultChecked={criteria.capabilities?.includes(c)} />
                    <Icone aria-hidden="true" className="size-4 text-neutral-500" />
                    {domaine(`capacites.${c}`)}
                  </label>
                );
              })}
            </fieldset>
            <label className="font-normal">
              <input type="checkbox" name="ue" value="1" defaultChecked={criteria.euOnly} /> {t("ueUniquement")}
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
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
          </div>
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
              <article
                key={m.modelName}
                aria-labelledby={`modele-${index}`}
                className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <h2 id={`modele-${index}`} className="my-0">
                  <Link href={levelPageHref(level, searchParams, m.modelName)} scroll={false}>
                    {m.displayName}
                  </Link>
                </h2>
                <p className="text-sm">{editeurEtZone(m)}</p>
                <code className="text-xs break-all text-neutral-600">{m.modelName}</code>
                {m.recommendedFor.length > 0 && (
                  <p className={`${PASTILLE} flex items-start gap-1 bg-amber-100 font-medium`}>
                    <Star aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 fill-amber-500 text-amber-600" />
                    {t("notreChoix", { cas: m.recommendedFor.map((u) => domaine(`casUsage.${u}`)).join(", ") })}
                  </p>
                )}
                {m.acceptsUpTo && <p className={`${PASTILLE} border-2 ${COULEURS_NIVEAUX[m.acceptsUpTo]}`}>{t("accepteJusqua", { niveau: m.acceptsUpTo })}</p>}
                <p className="line-clamp-2" title={m.shortDescription}>
                  {espacesInsecables(m.shortDescription)}
                </p>
                {m.capabilities.length > 0 && (
                  <ul aria-label={t("capacites")} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {m.capabilities.map((c) => {
                      const Icone = ICONES[c];
                      return (
                        <li key={c} className="inline-flex items-center gap-1">
                          <Icone aria-hidden="true" className="size-4 text-neutral-500" />
                          {domaine(`capacites.${c}`)}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {m.pricePerImage !== null ? (
                  // Modèle d'images : un prix par image, plus parlant qu'un prix par million de jetons ; pas de contexte.
                  <p className="text-sm">{t("prixImage", { prix: euros(m.pricePerImage) })}</p>
                ) : (
                  <>
                    <p className="leading-snug">
                      <span className="sr-only">{t(`repere.${REPERES[m.priceTier]}`)} : </span>
                      <span aria-hidden="true" title={t(`repere.${REPERES[m.priceTier]}`)} className="text-lg leading-none font-semibold">
                        {m.priceTier}
                      </span>
                      <span className="text-xs text-neutral-600">
                        {" · "}
                        {m.apiKind === "embeddings"
                          ? // Un modèle d'embeddings ne produit pas de jetons de sortie : seul son prix d'entrée compte.
                            t("prixEntree", { entree: euros(m.inputPricePerMillion) })
                          : t("prix", { entree: euros(m.inputPricePerMillion), sortie: euros(m.outputPricePerMillion) })}
                      </span>
                    </p>
                    {m.dimensions !== null && <p className="text-sm">{t("dimensions", { dimensions: nombre(m.dimensions) })}</p>}
                    <p className="text-sm">
                      {m.context ? (
                        <span title={t("hypothesePages")}>
                          {t("contexte", { jetons: nombre(m.context.tokens), pages: nombre(m.context.pages) })}{" "}
                          <Info aria-hidden="true" className="inline size-3.5 align-[-0.125em] text-neutral-500" />
                        </span>
                      ) : (
                        t("contexteInconnu")
                      )}
                    </p>
                  </>
                )}
                {m.useCases.length > 0 && (
                  <ul aria-label={t("casUsage")} className="flex flex-wrap gap-2 text-sm">
                    {m.useCases.map((u) => (
                      <li key={u} className={`${PASTILLE} bg-neutral-100`}>
                        {domaine(`casUsage.${u}`)}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Le nom du modèle mène aussi à sa fiche, mais un lien explicite se remarque mieux (retours de recette). */}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-2">
                  <label className="mt-0 font-normal">
                    <input type="checkbox" name="modeles" value={m.modelName} aria-label={t("selectionnerModele", { nom: m.displayName })} />{" "}
                    {t("selectionner")}
                  </label>
                  <Link href={levelPageHref(level, searchParams, m.modelName)} scroll={false} className="text-sm">
                    {t.rich("voirFiche", { nom: m.displayName, masque: (texte) => <span className="sr-only">{texte}</span> })}
                    {" "}
                    <ArrowRight aria-hidden="true" className="inline size-3.5 align-[-0.125em]" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </form>
      )}
      {detail && (
        <aside
          role="dialog"
          aria-labelledby="detail-titre"
          className="fixed inset-y-0 right-0 z-10 flex w-full max-w-2xl flex-col gap-2 overflow-y-auto border-l border-neutral-300 bg-white p-6 shadow-xl"
        >
          <p className="text-right">
            <Link href={levelPageHref(level, searchParams, null)} scroll={false} className="inline-flex items-center gap-1">
              <X aria-hidden="true" className="size-4" />
              {detailT("fermer")}
            </Link>
          </p>
          <h2 id="detail-titre" className="my-0">
            {detail.displayName}
          </h2>
          <p className="text-sm">{editeurEtZone(detail)}</p>
          <code className="text-xs break-all text-neutral-600">{detail.modelName}</code>
          {detail.acceptsUpTo && (
            <p className={`${PASTILLE} border-2 ${COULEURS_NIVEAUX[detail.acceptsUpTo]}`}>{t("accepteJusqua", { niveau: detail.acceptsUpTo })}</p>
          )}
          <h3 className="mt-3 font-medium">{detailT("description")}</h3>
          <p className="whitespace-pre-line">{espacesInsecables(detail.longDescription)}</p>
          <h3 className="mt-3 font-medium">{detailT("hebergeurs")}</h3>
          <p>{detail.hosts.join(", ") || domaine("nonRenseigne")}</p>
          <h3 className="mt-3 font-medium">{detailT("limites")}</h3>
          <p className="whitespace-pre-line">{detail.limitations ? espacesInsecables(detail.limitations) : detailT("aucuneLimite")}</p>
          {detail.apiKind === "decision" && (
            <>
              <h3 className="mt-3 font-medium">{detailT("apiDecision.titre")}</h3>
              <p>{detailT("apiDecision.explication")}</p>
            </>
          )}
          {detail.apiKind === "image" && (
            <>
              <h3 className="mt-3 font-medium">{detailT("apiImage.titre")}</h3>
              <p>{detailT("apiImage.explication")}</p>
            </>
          )}
          {detail.apiKind === "embeddings" && (
            <>
              <h3 className="mt-3 font-medium">{detailT("apiEmbeddings.titre")}</h3>
              <p>{detailT("apiEmbeddings.explication")}</p>
            </>
          )}
          <h3 className="mt-3 font-medium">{detailT("exempleAppel")}</h3>
          {(() => {
            const exemple = exemplesAppel(detail.modelName, detail.apiKind, {
              message: detailT("exemple.message"),
              etat: detailT("exemple.etat"),
              question: detailT("exemple.question"),
              image: detailT("exemple.image"),
              aVectoriser: [detailT("exemple.aVectoriser1"), detailT("exemple.aVectoriser2")],
            }).curl;
            return (
              <>
                {/* En entier : sans rétrécir dans la colonne du panneau (c'est le panneau qui défile), lignes repliées. */}
                <pre className="shrink-0 rounded bg-neutral-900 p-3 text-xs whitespace-pre-wrap text-neutral-100 wrap-anywhere">
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
