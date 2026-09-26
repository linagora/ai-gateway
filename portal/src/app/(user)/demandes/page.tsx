import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listMyRequests } from "@/lib/services/requests";
import { getDeps, requireUser } from "@/lib/session";
import { cancelRequestAction } from "../../actions";
import { Notice, formats } from "../../components";

/** F-24 : mes demandes, leur statut et le commentaire de l'admin ; annuler ou compléter. */
export default async function MyRequestsPage(props: PageProps<"/demandes">) {
  const user = await requireUser();
  const [{ date }, t, domaine] = await Promise.all([formats(), getTranslations("mesDemandes"), getTranslations("domaine")]);
  const searchParams = await props.searchParams;
  const requests = await listMyRequests(getDeps(), user);

  return (
    <>
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      <p>
        <Link href="/demandes/nouvelle">{t("nouvelleCle")}</Link> · <Link href="/demandes/adhesion">{t("rejoindreEquipe")}</Link>
      </p>
      <table className="mt-4">
        <thead>
          <tr>
            <th>{t("colonnes.date")}</th>
            <th>{t("colonnes.type")}</th>
            <th>{t("colonnes.equipe")}</th>
            <th>{t("colonnes.niveau")}</th>
            <th>{t("colonnes.modeles")}</th>
            <th>{t("colonnes.statut")}</th>
            <th>{t("colonnes.commentaire")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{date(r.createdAt)}</td>
              <td>{domaine(`typesDemande.${r.kind}`)}</td>
              <td>{r.teamAlias}</td>
              <td>{r.dataLevel ? domaine(`niveaux.${r.dataLevel}`) : ""}</td>
              <td>{r.offer ?? r.models.join(", ")}</td>
              <td>{domaine(`statuts.${r.status}`)}</td>
              <td>{r.decisionComment ?? ""}</td>
              <td>
                {r.status === "A_COMPLETER" && r.kind === "CLE" && <Link href={`/demandes/nouvelle?completer=${r.id}`}>{t("completer")}</Link>}
                {r.status === "A_COMPLETER" && r.kind === "ABONNEMENT" && <Link href={`/demandes/abonnement?completer=${r.id}`}>{t("completer")}</Link>}
                {r.status === "APPROUVEE" && r.kind === "CLE" && <Link href="/cles">{t("retirer")}</Link>}
                {r.status === "APPROUVEE" && r.kind === "ABONNEMENT" && <Link href="/abonnements">{t("declarer")}</Link>}
                {(r.status === "SOUMISE" || r.status === "A_COMPLETER") && (
                  <form action={cancelRequestAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit">{t("annuler")}</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests.length === 0 && <p className="mt-4">{t("aucune")}</p>}
    </>
  );
}
