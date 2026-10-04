import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nouveaute } from "@/lib/services/nouveautes";
import { getDeps, requireUser } from "@/lib/session";
import { espacesInsecables } from "@/lib/typographie";
import { marquerLueAction } from "../../../actions";
import { CategorieNouveaute } from "../../../categorie-nouveaute";
import { formats, Notice } from "../../../components";

/**
 * Spécification #124, tickets #130 et #135 : page d'une nouveauté publiée, avec « J'ai lu » tant que le collaborateur
 * ne l'a pas acquittée, sauf si elle est antérieure à sa fenêtre. Ouvrir la page ne l'acquitte pas. Un brouillon y est
 * introuvable.
 */
export default async function NouveautePage(props: PageProps<"/nouveautes/[id]">) {
  const user = await requireUser();
  const [{ id }, searchParams, t, { jour, date }] = await Promise.all([props.params, props.searchParams, getTranslations("nouveautes"), formats()]);
  const n = await nouveaute(getDeps(), user, id);
  if (!n) notFound();

  return (
    <article>
      <p>
        <Link href="/nouveautes" className="inline-flex items-center gap-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("toutes")}
        </Link>
      </p>
      <Notice searchParams={searchParams} />
      <p className="flex flex-wrap gap-x-3 text-sm text-neutral-600">
        <CategorieNouveaute category={n.category} />
        <span>{t("publieeLe", { date: jour(n.publishedAt) })}</span>
      </p>
      <h1 className="mt-1">{n.title}</h1>
      <p className="whitespace-pre-line">{espacesInsecables(n.body)}</p>
      {/* Une nouveauté antérieure à la fenêtre du collaborateur n'est ni à acquitter, ni lue. */}
      {n.etat.statut === "non_lue" && (
        <form action={marquerLueAction} className="mt-6">
          <input type="hidden" name="id" value={n.id} />
          <button type="submit">{t("jaiLu")}</button>
        </form>
      )}
      {n.etat.statut === "lue" && <p className="mt-6 text-sm text-neutral-600">{t("lueLe", { date: date(n.etat.le) })}</p>}
    </article>
  );
}
