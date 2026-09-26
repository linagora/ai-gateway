import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { DUREES_ABONNEMENT } from "@/lib/durees";
import type { Langue } from "@/lib/langue";
import { listOffers } from "@/lib/services/offers";
import { listMyTeams } from "@/lib/services/requests";
import { subscriptionRequestDraft } from "@/lib/services/subscriptions";
import { getDeps, requireUser } from "@/lib/session";
import { demanderAbonnementAction } from "../../../actions";
import { ChoixEquipe } from "../../../choix-equipe";
import { equipesProposees, ExplicationObligatoires, formats, libelleDuree, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";

/**
 * Spécification #51, ticket #54 : demande d'abonnement à une offre du catalogue (?offre=<id>), ou complément d'une
 * demande renvoyée (?completer=<id>), pour l'une de ses équipes, avec l'engagement sur le niveau maximal de l'offre.
 */
export default async function DemandeAbonnementPage(props: PageProps<"/demandes/abonnement">) {
  const user = await requireUser();
  const [{ euros }, t, nouvelle, offres, domaine, langue, searchParams] = await Promise.all([
    formats(),
    getTranslations("demandeAbonnement"),
    getTranslations("nouvelleDemande"),
    getTranslations("catalogue.abonnements"),
    getTranslations("domaine"),
    getLocale() as Promise<Langue>,
    props.searchParams,
  ]);
  const deps = getDeps();
  const completing = typeof searchParams.completer === "string" ? searchParams.completer : "";
  const brouillon = completing ? await subscriptionRequestDraft(deps, user, completing) : null;
  const offreId = brouillon?.offerId ?? (typeof searchParams.offre === "string" ? searchParams.offre : "");
  const [teams, catalogue] = await Promise.all([listMyTeams(deps, user), listOffers(deps, langue)]);
  const offre = catalogue.find((o) => o.id === offreId);
  const equipes = await equipesProposees(user, teams);

  return (
    <>
      <h1>{completing ? t("titreCompleter") : t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {!offre ? (
        <p>
          {t("offreIntrouvable")} <Link href="/catalogue/abonnements">{t("voirOffres")}</Link>
        </p>
      ) : teams.length === 0 ? (
        <p>
          {nouvelle("aucuneEquipe")} <Link href="/demandes/adhesion">{nouvelle("rejoindreDabord")}</Link>
        </p>
      ) : (
        <form action={demanderAbonnementAction}>
          <input type="hidden" name="offerId" value={offre.id} />
          {completing && <input type="hidden" name="requestId" value={completing} />}
          <ExplicationObligatoires />
          <section aria-labelledby="offre-demandee" className="rounded border border-neutral-200 bg-neutral-50 p-3">
            <h2 id="offre-demandee" className="mt-0 text-base">
              {t("offre")} : {offre.name} ({offre.supplier})
            </h2>
            <p className="text-sm">{offres("prix", { prix: euros(offre.monthlyPriceEur) })}</p>
            <p className="text-sm">{offres("niveau", { niveau: domaine(`niveauxOffre.${offre.dataLevel}`) })}</p>
            <p className="text-sm">{offre.rules}</p>
          </section>
          <ChoixEquipe equipes={equipes} valeurInitiale={brouillon?.teamId}>
            {nouvelle("equipe")}
            <Obligatoire />
          </ChoixEquipe>
          <p className="text-sm">
            {nouvelle("equipeAbsente")} <Link href="/demandes/adhesion">{nouvelle("rejoindre")}</Link>
          </p>
          <label>
            {nouvelle("motif")}
            <Obligatoire />
            <textarea name="justification" required rows={3} defaultValue={brouillon?.justification} />
          </label>
          <label>
            {nouvelle("projet")}
            <input name="project" defaultValue={brouillon?.project ?? ""} />
          </label>
          <label>
            {nouvelle("duree")}
            <select name="requestedDays" defaultValue={brouillon?.requestedDays ?? 90}>
              {DUREES_ABONNEMENT.map((jours) => (
                <option key={jours} value={jours}>
                  {libelleDuree(domaine, jours)}
                </option>
              ))}
            </select>
          </label>
          <label className="font-normal">
            <input type="checkbox" name="commitment" required /> {t("engagement", { niveau: domaine(`niveauxOffre.${offre.dataLevel}`) })}
            <Obligatoire />
          </label>
          <button type="submit">{completing ? nouvelle("resoumettre") : nouvelle("envoyer")}</button>
        </form>
      )}
    </>
  );
}
