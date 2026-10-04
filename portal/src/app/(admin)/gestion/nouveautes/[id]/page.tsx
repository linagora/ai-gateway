import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nouveautePourAdmin } from "@/lib/services/nouveautes";
import { getDeps, requireAdminPage } from "@/lib/session";
import { ExplicationObligatoires, Notice } from "../../../../components";
import { AdminNav } from "../../admin-nav";
import { FormulaireNouveaute } from "../formulaire";

/** Ticket #134 : correction d'une nouveauté ; publiée, elle garde sa date de publication et ses accusés de lecture. */
export default async function CorrectionNouveautePage(props: PageProps<"/gestion/nouveautes/[id]">) {
  const admin = await requireAdminPage();
  const [{ id }, searchParams, t] = await Promise.all([props.params, props.searchParams, getTranslations("gestionNouveautes")]);
  const nouveaute = await nouveautePourAdmin(getDeps(), admin, id);
  if (!nouveaute) notFound();

  return (
    <>
      <AdminNav />
      <p>
        <Link href="/gestion/nouveautes" className="inline-flex items-center gap-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("titre")}
        </Link>
      </p>
      <h1>{t("corrigerTitre")}</h1>
      {nouveaute.publishedAt && <p className="text-sm text-neutral-600">{t("correctionPubliee")}</p>}
      <Notice searchParams={searchParams} />
      <ExplicationObligatoires />
      <FormulaireNouveaute nouveaute={nouveaute} />
    </>
  );
}
