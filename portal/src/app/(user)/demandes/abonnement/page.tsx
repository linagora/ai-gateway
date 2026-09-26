import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DUREE_ABONNEMENT_PAR_DEFAUT, DUREES_ABONNEMENT } from "@/lib/durees";
import type { Langue } from "@/lib/langue";
import { type CatalogOffer, listOffers } from "@/lib/services/offers";
import { offerChangeDraft, renewalDraft } from "@/lib/services/renouvellements";
import { listMyTeams } from "@/lib/services/requests";
import { subscriptionRequestDraft } from "@/lib/services/subscriptions";
import { getDeps, requireUser } from "@/lib/session";
import { demanderAbonnementAction, demanderChangementOffreAction, demanderRenouvellementAction } from "../../../actions";
import { ChoixEquipe } from "../../../choix-equipe";
import { equipesProposees, ExplicationObligatoires, formats, libelleDuree, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";

/**
 * Spécification #51 : demande d'abonnement à une offre du catalogue (?offre=<id>, ticket #54), ou complément d'une
 * demande renvoyée (?completer=<id>), pour l'une de ses équipes, avec l'engagement sur le niveau maximal de l'offre.
 * Ticket #59 : renouvellement d'un abonnement (?renouveler=<id>) ou changement d'offre (?changer=<id>), préremplis ;
 * l'équipe reste celle de l'abonnement.
 */
export default async function DemandeAbonnementPage(props: PageProps<"/demandes/abonnement">) {
  const searchParams = await props.searchParams;
  const parametre = (nom: string) => (typeof searchParams[nom] === "string" ? searchParams[nom] : "");
  if (parametre("renouveler")) return <Renouvellement abonnement={parametre("renouveler")} searchParams={searchParams} />;
  if (parametre("changer")) return <ChangementOffre abonnement={parametre("changer")} searchParams={searchParams} />;
  return <NouvelleDemande offreId={parametre("offre")} completing={parametre("completer")} searchParams={searchParams} />;
}

type Recherche = Awaited<PageProps<"/demandes/abonnement">["searchParams"]>;

/** Demande d'abonnement à une offre, ou complément d'une demande renvoyée. */
async function NouvelleDemande({ offreId, completing, searchParams }: { offreId: string; completing: string; searchParams: Recherche }) {
  const user = await requireUser();
  const [t, nouvelle, domaine, langue] = await Promise.all([
    getTranslations("demandeAbonnement"),
    getTranslations("nouvelleDemande"),
    getTranslations("domaine"),
    getLocale() as Promise<Langue>,
  ]);
  const deps = getDeps();
  const brouillon = completing ? await subscriptionRequestDraft(deps, user, completing, langue) : null;
  const [teams, catalogue] = await Promise.all([listMyTeams(deps, user), listOffers(deps, langue)]);
  const offre = brouillon?.offer ?? catalogue.find((o) => o.id === offreId);
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
          <PresentationOffre offre={offre} titre={t("offreDemandee", { offre: `${offre.name} (${offre.supplier})` })} />
          {/* Un renouvellement ou un changement d'offre garde l'équipe de son abonnement. */}
          {brouillon?.linked ? (
            <>
              <p className="text-sm">{t(brouillon.linked === "RENOUVELLEMENT" ? "completerRenouvellement" : "completerChangement", { equipe: brouillon.teamAlias })}</p>
              <input type="hidden" name="teamId" value={brouillon.teamId} />
            </>
          ) : (
            <>
              <ChoixEquipe equipes={equipes} valeurInitiale={brouillon?.teamId}>
                {nouvelle("equipe")}
                <Obligatoire />
              </ChoixEquipe>
              <p className="text-sm">
                {nouvelle("equipeAbsente")} <Link href="/demandes/adhesion">{nouvelle("rejoindre")}</Link>
              </p>
            </>
          )}
          <ChampsCommuns valeurs={brouillon} engagement={t("engagement", { niveau: domaine(`niveauxOffre.${offre.dataLevel}`) })} />
          <button type="submit">{completing ? nouvelle("resoumettre") : nouvelle("envoyer")}</button>
        </form>
      )}
    </>
  );
}

/** Ticket #59 : renouvellement d'un abonnement, prérempli avec sa demande d'origine. */
async function Renouvellement({ abonnement, searchParams }: { abonnement: string; searchParams: Recherche }) {
  const user = await requireUser();
  const [{ jour }, t, domaine, langue] = await Promise.all([formats(), getTranslations("demandeAbonnement"), getTranslations("domaine"), getLocale() as Promise<Langue>]);
  const brouillon = await renewalDraft(getDeps(), user, abonnement, langue);
  return (
    <>
      <h1>{t("titreRenouveler")}</h1>
      <Notice searchParams={searchParams} />
      {!brouillon ? (
        <p>
          {t("renouvellementImpossible")} <Link href="/abonnements">{t("retourAbonnements")}</Link>
        </p>
      ) : (
        <form action={demanderRenouvellementAction}>
          <input type="hidden" name="subscriptionId" value={brouillon.subscriptionId} />
          <ExplicationObligatoires />
          <PresentationOffre offre={brouillon.offer} titre={t("abonnementRenouvele", { offre: `${brouillon.offer.name} (${brouillon.offer.supplier})` })}>
            <p className="text-sm">{t("equipeEtEcheance", { equipe: brouillon.teamAlias, date: jour(brouillon.expiresAt) })}</p>
          </PresentationOffre>
          <p className="text-sm">{t("aideRenouvellement")}</p>
          <ChampsCommuns valeurs={brouillon} engagement={t("engagement", { niveau: domaine(`niveauxOffre.${brouillon.offer.dataLevel}`) })} />
          <button type="submit">{t("envoyerRenouvellement")}</button>
        </form>
      )}
    </>
  );
}

/** Ticket #59 : changement d'offre d'un abonnement, vers une autre offre du même fournisseur. */
async function ChangementOffre({ abonnement, searchParams }: { abonnement: string; searchParams: Recherche }) {
  const user = await requireUser();
  const [{ euros }, t, domaine, langue] = await Promise.all([formats(), getTranslations("demandeAbonnement"), getTranslations("domaine"), getLocale() as Promise<Langue>]);
  const brouillon = await offerChangeDraft(getDeps(), user, abonnement, langue);
  return (
    <>
      <h1>{t("titreChanger")}</h1>
      <Notice searchParams={searchParams} />
      {!brouillon ? (
        <p>
          {t("abonnementIntrouvable")} <Link href="/abonnements">{t("retourAbonnements")}</Link>
        </p>
      ) : brouillon.offers.length === 0 ? (
        <p>
          {t("aucuneAutreOffre", { offre: brouillon.currentOffer })} <Link href="/abonnements">{t("retourAbonnements")}</Link>
        </p>
      ) : (
        <form action={demanderChangementOffreAction}>
          <input type="hidden" name="subscriptionId" value={brouillon.subscriptionId} />
          <ExplicationObligatoires />
          <p>{t("abonnementRemplace", { offre: brouillon.currentOffer, equipe: brouillon.teamAlias })}</p>
          <fieldset>
            <legend className="font-medium">
              {t("nouvelleOffre")}
              <Obligatoire />
            </legend>
            {brouillon.offers.map((o) => (
              <label key={o.id} className="font-normal">
                <input type="radio" name="offerId" value={o.id} required />{" "}
                {t("choixOffre", { offre: o.name, prix: euros(o.monthlyPriceEur), niveau: domaine(`niveauxOffre.${o.dataLevel}`) })}
              </label>
            ))}
          </fieldset>
          <p className="text-sm">{t("aideChangement")}</p>
          <ChampsCommuns engagement={t("engagementOffreChoisie")} />
          <button type="submit">{t("envoyerChangement")}</button>
        </form>
      )}
    </>
  );
}

/** Présentation d'une offre dans un formulaire : prix mensuel TTC, niveau maximal et règles d'usage. */
async function PresentationOffre({ offre, titre, children }: { offre: CatalogOffer; titre: string; children?: ReactNode }) {
  const [{ euros }, offres, domaine] = await Promise.all([formats(), getTranslations("catalogue.abonnements"), getTranslations("domaine")]);
  return (
    <section aria-labelledby="offre-demandee" className="rounded border border-neutral-200 bg-neutral-50 p-3">
      <h2 id="offre-demandee" className="mt-0 text-base">
        {titre}
      </h2>
      {children}
      <p className="text-sm">{offres("prix", { prix: euros(offre.monthlyPriceEur) })}</p>
      <p className="text-sm">{offres("niveau", { niveau: domaine(`niveauxOffre.${offre.dataLevel}`) })}</p>
      <p className="text-sm">{offre.rules}</p>
    </section>
  );
}

/** Motif, projet, durée souhaitée et engagement : les champs communs à toute demande d'abonnement. */
async function ChampsCommuns({ valeurs, engagement }: { valeurs?: { justification: string; project: string | null; requestedDays: number } | null; engagement: string }) {
  const [nouvelle, domaine] = await Promise.all([getTranslations("nouvelleDemande"), getTranslations("domaine")]);
  return (
    <>
      <label>
        {nouvelle("motif")}
        <Obligatoire />
        <textarea name="justification" required rows={3} defaultValue={valeurs?.justification} />
      </label>
      <label>
        {nouvelle("projet")}
        <input name="project" defaultValue={valeurs?.project ?? ""} />
      </label>
      <label>
        {nouvelle("duree")}
        <select name="requestedDays" defaultValue={valeurs?.requestedDays ?? DUREE_ABONNEMENT_PAR_DEFAUT}>
          {DUREES_ABONNEMENT.map((jours) => (
            <option key={jours} value={jours}>
              {libelleDuree(domaine, jours)}
            </option>
          ))}
        </select>
      </label>
      <label className="font-normal">
        <input type="checkbox" name="commitment" required /> {engagement}
        <Obligatoire />
      </label>
    </>
  );
}
