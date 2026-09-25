import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listPendingRequests, listProcessedRequests } from "@/lib/services/admin-requests";
import { getDeps, requireAdminPage } from "@/lib/session";
import { Notice, formats } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-30 : demandes en attente, de la plus ancienne à la plus récente, puis l'archive des demandes traitées. */
export default async function PendingRequestsPage(props: PageProps<"/gestion/demandes">) {
  const admin = await requireAdminPage();
  const [{ date }, t, domaine, searchParams] = await Promise.all([formats(), getTranslations("gestion.file"), getTranslations("domaine"), props.searchParams]);
  const [pending, traitees] = await Promise.all([listPendingRequests(getDeps(), admin), listProcessedRequests(getDeps(), admin)]);

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

      <section aria-labelledby="archive" className="mt-10">
        <h2 id="archive">{t("archive.titre")}</h2>
        {traitees.length === 0 ? (
          <p>{t("archive.aucune")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("archive.colonnes.date")}</th>
                <th>{t("colonnes.demandeur")}</th>
                <th>{t("colonnes.type")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.niveau")}</th>
                <th>{t("archive.colonnes.statut")}</th>
                <th>{t("archive.colonnes.decision")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {traitees.map((r) => (
                <tr key={r.id}>
                  <td>{date(r.updatedAt)}</td>
                  <td>{r.requesterUid}</td>
                  <td>{domaine(`typesDemande.${r.kind}`)}</td>
                  <td>{r.teamAlias}</td>
                  <td>{r.dataLevel ? domaine(`niveaux.${r.dataLevel}`) : "—"}</td>
                  <td>{domaine(`statuts.${r.status}`)}</td>
                  <td>{r.decidedBy ? [r.decidedBy, r.decisionComment].filter(Boolean).join(" : ") : "—"}</td>
                  <td>
                    <Link href={`/gestion/demandes/${r.id}`}>{t("archive.voir")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
