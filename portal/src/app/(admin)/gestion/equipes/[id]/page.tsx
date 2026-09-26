import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { getTeamOverview } from "@/lib/services/teams";
import { getDeps, requireAdminPage } from "@/lib/session";
import { renommerEquipeAction } from "../../../../actions";
import { Notice } from "../../../../components";
import { AdminNav } from "../../admin-nav";

/** F-53 : page d'une équipe : son résumé et son renommage. */
export default async function EquipePage(props: PageProps<"/gestion/equipes/[id]">) {
  const admin = await requireAdminPage();
  const [{ id }, t, searchParams] = await Promise.all([props.params, getTranslations("gestion.equipes"), props.searchParams]);
  const equipe = await getTeamOverview(getDeps(), admin, decodeURIComponent(id)).catch((e: unknown) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });

  return (
    <>
      <AdminNav />
      <p>
        <Link href="/gestion/equipes">
          <span aria-hidden="true">← </span>
          {t("toutes")}
        </Link>
      </p>
      <h1>{equipe.teamAlias}</h1>
      <Notice searchParams={searchParams} />
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1" aria-label={t("resume")}>
        <dt>{t("colonnes.membres")}</dt>
        <dd>{equipe.memberCount}</dd>
        <dt>{t("colonnes.cles")}</dt>
        <dd>{equipe.activeKeyCount}</dd>
      </dl>
      <form action={renommerEquipeAction} className="mt-6 flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={equipe.teamId} />
        <label>
          {t("nom")}
          <input name="nom" required maxLength={100} defaultValue={equipe.teamAlias} />
        </label>
        <button type="submit">{t("renommer")}</button>
      </form>
    </>
  );
}
