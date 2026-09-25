import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Capability } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
import { levelFromSegment } from "@/lib/level-routes";
import { levelModels, type PriceTier } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../../components";
import { COULEURS_NIVEAUX } from "../couleurs";

/** Icônes des capacités, toujours accompagnées de leur libellé. */
const ICONES: Record<Capability, string> = { images: "🖼️", audio_video: "🎧", raisonnement: "🧠" };
const REPERES: Record<PriceTier, "bas" | "moyen" | "eleve"> = { "€": "bas", "€€": "moyen", "€€€": "eleve" };

/** Ticket #7 : les modèles d'un niveau, en cartes (lecture cumulative, niveau Expérimental à part). */
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
  const models = await levelModels(getDeps(), { level, language });

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
      {models.length === 0 ? (
        <p className="mt-6 italic">{catalogue("aucunModele")}</p>
      ) : (
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
