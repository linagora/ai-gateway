import { getTranslations } from "next-intl/server";
import { listJoinableTeams } from "@/lib/services/requests";
import { getDeps, requireUser } from "@/lib/session";
import { createTeamJoinRequestAction } from "../../../actions";
import { ChoixEquipe } from "../../../choix-equipe";
import { equipesProposees, ExplicationObligatoires, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";

/** F-22 : demander à rejoindre une équipe existante ; un administrateur valide. */
export default async function TeamJoinPage(props: PageProps<"/demandes/adhesion">) {
  const user = await requireUser();
  const [t, searchParams] = await Promise.all([getTranslations("adhesion"), props.searchParams]);
  const teams = await listJoinableTeams(getDeps(), user);
  const equipes = await equipesProposees(user, teams);

  return (
    <>
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {teams.length === 0 ? (
        <p>{t("aucuneEquipe")}</p>
      ) : (
        <form action={createTeamJoinRequestAction}>
          <ExplicationObligatoires />
          <ChoixEquipe equipes={equipes}>
            {t("equipe")}
            <Obligatoire />
          </ChoixEquipe>
          <label>
            {t("motif")}
            <Obligatoire />
            <textarea name="justification" required rows={3} />
          </label>
          <button type="submit">{t("envoyer")}</button>
        </form>
      )}
    </>
  );
}
