import { listJoinableTeams } from "@/lib/services/requests";
import { getDeps, requireUser } from "@/lib/session";
import { createTeamJoinRequestAction } from "../../../actions";
import { Notice } from "../../../components";

/** F-22 : demander à rejoindre une équipe existante ; un administrateur valide. */
export default async function TeamJoinPage(props: PageProps<"/demandes/adhesion">) {
  const user = await requireUser();
  const searchParams = await props.searchParams;
  const teams = await listJoinableTeams(getDeps(), user);

  return (
    <>
      <h1>Demander à rejoindre une équipe</h1>
      <Notice searchParams={searchParams} />
      {teams.length === 0 ? (
        <p>Aucune autre équipe n&apos;existe pour l&apos;instant : contactez un administrateur.</p>
      ) : (
        <form action={createTeamJoinRequestAction}>
          <label>
            Équipe
            <select name="teamId" required>
              {teams.map((t) => (
                <option key={t.teamId} value={t.teamId}>
                  {t.teamAlias}
                </option>
              ))}
            </select>
          </label>
          <label>
            Motif
            <textarea name="justification" required rows={3} />
          </label>
          <button type="submit">Envoyer la demande</button>
        </form>
      )}
    </>
  );
}
