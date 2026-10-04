import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { archiveNouveautes } from "@/lib/services/nouveautes";
import { getDeps, requireUser } from "@/lib/session";
import { CategorieNouveaute } from "../../categorie-nouveaute";
import { formats, PaginationArchive } from "../../components";

/** Spécification #124, ticket #131 : archive « Toutes les nouveautés », avec l'état de chacune pour le collaborateur. */
export default async function ArchiveNouveautesPage(props: PageProps<"/nouveautes">) {
  const user = await requireUser();
  const [t, { jour }, searchParams] = await Promise.all([getTranslations("nouveautes"), formats(), props.searchParams]);
  const archive = await archiveNouveautes(getDeps(), user, Number(searchParams.page) || 1);

  return (
    <>
      <h1>{t("toutes")}</h1>
      {archive.total === 0 ? (
        <p className="italic">{t("aucunePubliee")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {archive.elements.map((n) => (
            <li key={n.id} className="border-t border-neutral-200 pt-3 first:border-0 first:pt-0">
              <p className="m-0 flex flex-wrap gap-x-3 text-sm text-neutral-600">
                <CategorieNouveaute category={n.category} />
                <span>{jour(n.publishedAt)}</span>
                {n.etat.statut === "non_lue" ? (
                  <span className="rounded-xl bg-linagora px-2 text-xs font-semibold text-white">{t("nonLue")}</span>
                ) : (
                  <span>{t("lueLe", { date: jour(n.etat.le) })}</span>
                )}
              </p>
              <Link href={`/nouveautes/${n.id}`} className={n.etat.statut === "non_lue" ? "font-semibold" : undefined}>
                {n.title}
              </Link>
              <p className="m-0 text-sm">{n.summary}</p>
            </li>
          ))}
        </ul>
      )}
      <PaginationArchive
        archive={archive}
        lien={(page) => `/nouveautes?page=${page}`}
        libelles={{
          pagination: t("pagination"),
          position: t("position", { page: archive.page, pages: archive.pages, total: archive.total }),
          plusRecentes: t("plusRecentes"),
          plusAnciennes: t("plusAnciennes"),
        }}
      />
    </>
  );
}
