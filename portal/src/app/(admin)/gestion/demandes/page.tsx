import Link from "next/link";
import { KIND_LABELS, LEVEL_LABELS } from "@/lib/labels";
import { listPendingRequests } from "@/lib/services/admin-requests";
import { getDeps, requireAdminPage } from "@/lib/session";
import { Notice, formats } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-30 : demandes en attente, de la plus ancienne à la plus récente. */
export default async function PendingRequestsPage(props: PageProps<"/gestion/demandes">) {
  const admin = await requireAdminPage();
  const { date } = await formats();
  const searchParams = await props.searchParams;
  const pending = await listPendingRequests(getDeps(), admin);

  return (
    <>
      <AdminNav />
      <h1>Demandes en attente de validation</h1>
      <Notice searchParams={searchParams} />
      <table>
        <thead>
          <tr>
            <th>Soumise le</th>
            <th>Demandeur</th>
            <th>Type</th>
            <th>Équipe</th>
            <th>Niveau</th>
            <th>Modèles</th>
            <th>Projet</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pending.map((r) => (
            <tr key={r.id}>
              <td>{date(r.createdAt)}</td>
              <td>{r.requesterUid}</td>
              <td>{KIND_LABELS[r.kind]}</td>
              <td>{r.teamAlias}</td>
              <td>{r.dataLevel ? LEVEL_LABELS[r.dataLevel] : "—"}</td>
              <td>{r.models.join(", ") || "—"}</td>
              <td>{r.project ?? ""}</td>
              <td>
                <Link href={`/gestion/demandes/${r.id}`}>Examiner</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pending.length === 0 && <p className="mt-4">Aucune demande en attente.</p>}
    </>
  );
}
