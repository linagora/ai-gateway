import Link from "next/link";
import { KIND_LABELS, LEVEL_LABELS, STATUS_LABELS } from "@/lib/labels";
import { listMyRequests } from "@/lib/services/requests";
import { getDeps, requireUser } from "@/lib/session";
import { cancelRequestAction } from "../../actions";
import { Notice, formats } from "../../components";

/** F-24 : mes demandes, leur statut et le commentaire de l'admin ; annuler ou compléter. */
export default async function MyRequestsPage(props: PageProps<"/demandes">) {
  const user = await requireUser();
  const { date } = await formats();
  const searchParams = await props.searchParams;
  const requests = await listMyRequests(getDeps(), user);

  return (
    <>
      <h1>Mes demandes</h1>
      <Notice searchParams={searchParams} />
      <p>
        <Link href="/demandes/nouvelle">Nouvelle demande de clé</Link> · <Link href="/demandes/adhesion">Demander à rejoindre une équipe</Link>
      </p>
      <table className="mt-4">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Équipe</th>
            <th>Niveau</th>
            <th>Modèles</th>
            <th>Statut</th>
            <th>Commentaire de l&apos;administrateur</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{date(r.createdAt)}</td>
              <td>{KIND_LABELS[r.kind]}</td>
              <td>{r.teamAlias}</td>
              <td>{r.dataLevel ? LEVEL_LABELS[r.dataLevel] : "—"}</td>
              <td>{r.models.join(", ") || "—"}</td>
              <td>{STATUS_LABELS[r.status]}</td>
              <td>{r.decisionComment ?? ""}</td>
              <td>
                {r.status === "A_COMPLETER" && r.kind === "CLE" && <Link href={`/demandes/nouvelle?completer=${r.id}`}>Compléter</Link>}
                {(r.status === "SOUMISE" || r.status === "A_COMPLETER") && (
                  <form action={cancelRequestAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit">Annuler</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests.length === 0 && <p className="mt-4">Aucune demande pour l&apos;instant.</p>}
    </>
  );
}
