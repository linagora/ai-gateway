import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listPendingRequests } from "@/lib/services/admin-requests";
import { getDeps, requireAdminPage } from "@/lib/session";
import { Notice, formats } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-30 : demandes en attente, de la plus ancienne à la plus récente. */
export default async function PendingRequestsPage(props: PageProps<"/gestion/demandes">) {
  const admin = await requireAdminPage();
  const [{ date }, t, domaine, searchParams] = await Promise.all([formats(), getTranslations("gestion.file"), getTranslations("domaine"), props.searchParams]);
  const pending = await listPendingRequests(getDeps(), admin);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      <table>
        <thead>
          <tr>
            <th>{t("colonnes.soumise")}</th>
            <th>{t("colonnes.demandeur")}</th>
            <th>{t("colonnes.type")}</th>
            <th>{t("colonnes.equipe")}</th>
            <th>{t("colonnes.niveau")}</th>
            <th>{t("colonnes.modeles")}</th>
            <th>{t("colonnes.projet")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pending.map((r) => (
            <tr key={r.id}>
              <td>{date(r.createdAt)}</td>
              <td>{r.requesterUid}</td>
              <td>{domaine(`typesDemande.${r.kind}`)}</td>
              <td>{r.teamAlias}</td>
              <td>{r.dataLevel ? domaine(`niveaux.${r.dataLevel}`) : "—"}</td>
              <td>{r.models.join(", ") || "—"}</td>
              <td>{r.project ?? ""}</td>
              <td>
                <Link href={`/gestion/demandes/${r.id}`}>{t("examiner")}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pending.length === 0 && <p className="mt-4">{t("aucune")}</p>}
    </>
  );
}
