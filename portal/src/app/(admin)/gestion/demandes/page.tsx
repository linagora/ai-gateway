import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listPendingRequests, listProcessedRequests, type PendingRequest } from "@/lib/services/admin-requests";
import { getDeps, requireGestionPage } from "@/lib/session";
import { Notice, PaginationArchive, formats } from "../../../components";
import { AdminNav } from "../admin-nav";
import { LienCollaborateur } from "../lien-collaborateur";

/**
 * F-30 : la file de validation, de la plus ancienne demande à la plus récente, en deux parties : ce qui attend l'acteur,
 * puis ce qui attend quelqu'un d'autre (spécification #93) ; ensuite l'archive des demandes traitées, page par page.
 */
export default async function PendingRequestsPage(props: PageProps<"/gestion/demandes">) {
  const admin = await requireGestionPage();
  const [{ date }, t, domaine, searchParams] = await Promise.all([formats(), getTranslations("gestion.file"), getTranslations("domaine"), props.searchParams]);
  const [file, archive] = await Promise.all([listPendingRequests(getDeps(), admin), listProcessedRequests(getDeps(), admin, Number(searchParams.page) || 1)]);
  // Spécification #93 : un admin approuve, et peut décider sans attendre l'accord d'un responsable ; un responsable
  // traite les demandes de ses équipes et suit, en lecture seule, celles qui ont reçu l'accord.
  const parties = admin.isAdmin
    ? { aTraiter: t("aApprouver"), aSuivre: t("attenteAccordResponsable"), lienASuivre: t("examiner") }
    : { aTraiter: t("aTraiter"), aSuivre: t("attenteApprobationAdmin"), lienASuivre: t("archive.voir") };

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      <section aria-labelledby="a-traiter">
        <h2 id="a-traiter">{parties.aTraiter}</h2>
        <PartieDeLaFile demandes={file.aTraiter} libelleDuLien={t("examiner")} />
      </section>
      <section aria-labelledby="a-suivre" className="mt-10">
        <h2 id="a-suivre">{parties.aSuivre}</h2>
        <PartieDeLaFile demandes={file.aSuivre} libelleDuLien={parties.lienASuivre} />
      </section>

      <section aria-labelledby="archive" className="mt-10">
        <h2 id="archive">{t("archive.titre")}</h2>
        {archive.total === 0 ? (
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
              {archive.elements.map((r) => (
                <tr key={r.id}>
                  <td>{date(r.updatedAt)}</td>
                  <td>
                    <LienCollaborateur uid={r.requesterUid} />
                  </td>
                  <td>{domaine(`typesDemande.${r.kind}`)}</td>
                  <td>{r.teamAlias}</td>
                  <td>{r.dataLevel ? domaine(`niveaux.${r.dataLevel}`) : ""}</td>
                  <td>{domaine(`statuts.${r.status}`)}</td>
                  <td>{r.decidedBy ? [r.decidedBy, r.decisionComment].filter(Boolean).join(" : ") : ""}</td>
                  <td>
                    <Link href={`/gestion/demandes/${r.id}`}>{t("archive.voir")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PaginationArchive
          archive={archive}
          lien={(page) => `/gestion/demandes?page=${page}`}
          libelles={{
            pagination: t("archive.pagination"),
            position: t("archive.position", { page: archive.page, pages: archive.pages, total: archive.total }),
            plusRecentes: t("archive.plusRecentes"),
            plusAnciennes: t("archive.plusAnciennes"),
          }}
        />
      </section>
    </>
  );
}

/** Une partie de la file de validation : chaque demande, avec le lien vers sa fiche. */
async function PartieDeLaFile({ demandes, libelleDuLien }: { demandes: PendingRequest[]; libelleDuLien: string }) {
  const [{ date }, t, domaine] = await Promise.all([formats(), getTranslations("gestion.file"), getTranslations("domaine")]);
  if (demandes.length === 0) return <p>{t("aucune")}</p>;
  return (
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
        {demandes.map((r) => (
          <tr key={r.id}>
            <td>{date(r.createdAt)}</td>
            <td>
              <LienCollaborateur uid={r.requesterUid} />
            </td>
            <td>{domaine(`typesDemande.${r.kind}`)}</td>
            <td>{r.teamAlias}</td>
            <td>{r.dataLevel ? domaine(`niveaux.${r.dataLevel}`) : ""}</td>
            <td>{r.offer ?? r.models.join(", ")}</td>
            <td>{r.project ?? ""}</td>
            <td>
              <Link href={`/gestion/demandes/${r.id}`}>{libelleDuLien}</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
