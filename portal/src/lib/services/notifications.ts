import { createTranslator } from "next-intl";
import type { AccessRequest, Subscription, SubscriptionOffer } from "@/generated/prisma/client";
import type { Mailer, Message } from "@/lib/courriel";
import { DUREES_VALIDITE, joursDePeriode } from "@/lib/durees";
import type { Langue } from "@/lib/langue";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { libelleOffre } from "./offers";

/** Dépendances des notifications : sans expéditeur, rien n'est envoyé et rien n'est bloqué. */
export interface NotificationDeps {
  mailer?: Mailer | null;
  adminEmails?: string[];
  /** Adresse publique du portail, pour les liens des courriels. */
  portalUrl?: string;
}

/** En tête de l'objet de chaque courriel du portail (retours de recette du 2026-09-25). */
const PREFIXE_OBJET = "[AI GATEWAY]";

const TRADUCTEURS = [
  createTranslator({ locale: "fr", messages: fr, timeZone: "Europe/Paris" }),
  createTranslator({ locale: "en", messages: en, timeZone: "Europe/Paris" }),
] as const;
type Traducteur = (typeof TRADUCTEURS)[number];

/** Contenu d'un courriel dans une langue : l'objet, puis les paragraphes du corps. */
interface Contenu {
  sujet: string;
  paragraphes: string[];
}

/** Langue de chaque traducteur, dans l'ordre des courriels : le français, puis l'anglais. */
const LANGUES_DES_COURRIELS: readonly Langue[] = ["fr", "en"];

/**
 * Courriel bilingue : le même contenu en français puis en anglais, chacun suivi du lien. Le contenu de chaque
 * langue est calculé par `contenu`, qui reçoit le traducteur de cette langue (textes des dictionnaires) et la langue,
 * pour les textes saisis dans les deux langues (règles d'une offre).
 */
function bilingue(contenu: (t: Traducteur, langue: Langue) => Contenu, lien: string): Omit<Message, "to"> {
  const [francais, anglais] = TRADUCTEURS.map((t, i) => {
    const { sujet, paragraphes } = contenu(t, LANGUES_DES_COURRIELS[i]);
    return { sujet, corps: [...paragraphes, t("courriels.lien", { url: lien })].join("\n\n") };
  });
  return {
    subject: `${PREFIXE_OBJET} ${francais.sujet} / ${anglais.sujet}`,
    text: [francais.corps, "* * *", anglais.corps, "LINAGORA AI Gateway"].join("\n\n"),
  };
}

/** Envoie sans jamais faire échouer l'action : un échec est journalisé, sans secret. */
async function envoyer(deps: NotificationDeps, to: string[], message: Omit<Message, "to">): Promise<void> {
  if (!deps.mailer || to.length === 0) return;
  try {
    await deps.mailer.send({ ...message, to });
  } catch (e) {
    console.error(`Courriel non envoyé (« ${message.subject} ») : ${e instanceof Error ? e.message : "erreur inconnue"}`);
  }
}

/** Destinataires d'une annonce, sans doublon : les admins (sauf `admins` à faux) et les responsables désignés par le service. */
const adminsEtResponsables = (deps: NotificationDeps, responsables: string[], admins = true) => [...new Set([...(admins ? (deps.adminEmails ?? []) : []), ...responsables])];

const lienVers = (deps: NotificationDeps, chemin: string) => `${(deps.portalUrl ?? "").replace(/\/$/, "")}${chemin}`;

/** Nom du demandeur ; les demandes antérieures à son enregistrement n'ont que son identifiant. */
const nom = (r: AccessRequest) => r.requesterName || r.requesterUid;

/** Titulaire d'un abonnement, tel que le salue un courriel ; sans nom enregistré, son identifiant. */
const titulaire = (a: Pick<Subscription, "holderUid" | "holderName">) => a.holderName || a.holderUid;

/** Nom d'une durée de validité : « 3 mois », « N'expire jamais », ou « 60 jours » hors de la liste proposée. */
function duree(t: Traducteur, jours: number): string {
  const proposee = DUREES_VALIDITE.find((d) => d === jours);
  return proposee !== undefined ? t(`domaine.durees.${proposee}`) : t("domaine.dureeEnJours", { nombre: jours });
}

/** Période de budget au format LiteLLM (30d…), en jours quand c'est possible. */
function periode(t: Traducteur, budgetDuration: string): string {
  const jours = joursDePeriode(budgetDuration);
  return jours !== null ? t("domaine.dureeEnJours", { nombre: jours }) : budgetDuration;
}

/** Libellés des lignes d'un récapitulatif (dictionnaires, espace « courriels.recap »). */
type Libelle =
  | "equipe"
  | "niveau"
  | "modeles"
  | "modelesAccordes"
  | "projet"
  | "motif"
  | "dureeSouhaitee"
  | "budget"
  | "validite"
  | "expiration"
  | "offre"
  | "prixMensuel"
  | "niveauMaximal"
  | "nom"
  | "perimetre"
  | "adresses"
  | "plafond"
  | "kid"
  | "algorithme"
  | "empreinte";

/** Demande, avec l'offre demandée quand c'est une demande d'abonnement (spécification #51). */
type DemandeAvecOffre = AccessRequest & { offer?: Pick<SubscriptionOffer, "supplier" | "name" | "monthlyPriceEur" | "dataLevel"> | null };

/** Lignes « - Libellé : valeur » d'un récapitulatif ; les valeurs absentes sont omises. */
function lignes(t: Traducteur, champs: [libelle: Libelle, valeur: string | null | undefined][]): string[] {
  return champs.flatMap(([libelle, valeur]) => (valeur ? [t("courriels.recap.ligne", { libelle: t(`courriels.recap.${libelle}`), valeur })] : []));
}

/** Ce que le salarié a demandé : équipe, niveau, modèles, projet, motif et durée souhaitée ; pour un abonnement, l'offre. */
function recapDemande(t: Traducteur, r: DemandeAvecOffre): string[] {
  if (r.kind === "ABONNEMENT" && r.offer) return recapAbonnement(t, r, r.offer);
  return lignes(t, [
    ["equipe", r.teamAlias],
    ["niveau", r.dataLevel && t(`domaine.niveaux.${r.dataLevel}`)],
    ["modeles", r.models.join(", ")],
    ["projet", r.project],
    ["motif", r.justification],
    ["dureeSouhaitee", r.requestedDays !== null ? duree(t, r.requestedDays) : null],
  ]);
}

/** Demande d'abonnement : équipe, offre et son prix mensuel TTC, niveau maximal, projet, motif et durée souhaitée. */
function recapAbonnement(t: Traducteur, r: AccessRequest, offre: NonNullable<DemandeAvecOffre["offer"]>): string[] {
  return lignes(t, [
    ["equipe", r.teamAlias],
    ["offre", libelleOffre(offre)],
    ["prixMensuel", t("courriels.recap.prixMensuelValeur", { montant: offre.monthlyPriceEur.toNumber() })],
    ["niveauMaximal", t(`domaine.niveauxOffre.${offre.dataLevel}`)],
    ["projet", r.project],
    ["motif", r.justification],
    ["dureeSouhaitee", r.requestedDays !== null ? duree(t, r.requestedDays) : null],
  ]);
}

/** Ce qu'un admin a approuvé : les paramètres de la clé. */
function recapApprobation(t: Traducteur, r: AccessRequest): string[] {
  return lignes(t, [
    ["equipe", r.teamAlias],
    ["niveau", r.dataLevel && t(`domaine.niveaux.${r.dataLevel}`)],
    ["modelesAccordes", r.approvedModels.join(", ")],
    ["budget", r.approvedBudget && r.budgetDuration && t("courriels.recap.budgetValeur", { montant: r.approvedBudget.toNumber(), periode: periode(t, r.budgetDuration) })],
    ["validite", r.approvedDays !== null ? duree(t, r.approvedDays) : null],
    ["projet", r.project],
  ]);
}

/** La clé émise : équipe, niveau, modèles, projet et expiration. */
function recapCle(t: Traducteur, r: AccessRequest): string[] {
  return lignes(t, [
    ["equipe", r.teamAlias],
    ["niveau", r.dataLevel && t(`domaine.niveaux.${r.dataLevel}`)],
    ["modeles", r.approvedModels.join(", ")],
    ["projet", r.project],
    ["expiration", r.keyExpiresAt ? t("courriels.recap.date", { date: r.keyExpiresAt }) : t("domaine.durees.0")],
  ]);
}

/** Paragraphe d'introduction suivi d'un récapitulatif en liste. */
const avecRecap = (introduction: string, recap: string[]) => [introduction, ...recap].join("\n");

/**
 * F-30 : chaque nouvelle demande est notifiée aux admins et aux responsables de l'équipe désignés par le service (hors
 * le demandeur) : qui la dépose, ce qu'elle demande, et le lien vers sa fiche.
 */
export async function notifyNewRequest(deps: NotificationDeps, demande: DemandeAvecOffre, responsables: string[] = []): Promise<void> {
  const qui = { nom: nom(demande), email: demande.requesterEmail };
  const message = bilingue(
    (t) =>
      demande.kind === "CLE"
        ? {
            sujet: t("courriels.nouvelleDemandeCle.sujet", qui),
            paragraphes: [t("courriels.bonjourAdmins"), avecRecap(t("courriels.nouvelleDemandeCle.corps", qui), recapDemande(t, demande)), t("courriels.examiner")],
          }
        : demande.kind === "ABONNEMENT"
          ? {
              sujet: t("courriels.nouvelleDemandeAbonnement.sujet", qui),
              paragraphes: [t("courriels.bonjourAdmins"), avecRecap(t("courriels.nouvelleDemandeAbonnement.corps", qui), recapDemande(t, demande)), t("courriels.examiner")],
            }
          : {
            sujet: t("courriels.nouvelleDemandeAdhesion.sujet", qui),
            paragraphes: [
              t("courriels.bonjourAdmins"),
              avecRecap(t("courriels.nouvelleDemandeAdhesion.corps", { ...qui, equipe: demande.teamAlias }), lignes(t, [["motif", demande.justification]])),
              t("courriels.examiner"),
            ],
          },
    lienVers(deps, `/gestion/demandes/${demande.id}`),
  );
  await envoyer(deps, adminsEtResponsables(deps, responsables), message);
}

/** F-40 : demande de clé approuvée, avec les paramètres de la clé et l'échéance de retrait ; jamais de clé. */
export async function notifyKeyApproved(deps: NotificationDeps, demande: AccessRequest, echeance: Date | null): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.demandeApprouvee.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        avecRecap(t("courriels.demandeApprouvee.corps", { equipe: demande.teamAlias }), recapApprobation(t, demande)),
        echeance ? t("courriels.demandeApprouvee.retrait", { date: echeance }) : t("courriels.demandeApprouvee.retraitSansEcheance"),
      ],
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/**
 * Spécification #51 : demande d'abonnement approuvée. Le demandeur apprend comment souscrire (de préférence avec son
 * adresse professionnelle, entraînement sur ses données désactivé), les règles d'usage de l'offre, et quand déclarer
 * l'abonnement dans « Mes abonnements ».
 */
export async function notifySubscriptionApproved(
  deps: NotificationDeps,
  demande: AccessRequest,
  offre: SubscriptionOffer,
  echeance: Date | null,
  /** Changement d'offre (ticket #59) : l'offre de l'abonnement remplacé, « Anthropic · Claude Max 5x ». */
  remplace: string | null = null,
): Promise<void> {
  const message = bilingue(
    (t, langue) => ({
      sujet: t("courriels.abonnementApprouve.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        avecRecap(
          t("courriels.abonnementApprouve.corps", { equipe: demande.teamAlias }),
          lignes(t, [
            ["offre", libelleOffre(offre)],
            ["prixMensuel", t("courriels.recap.prixMensuelValeur", { montant: offre.monthlyPriceEur.toNumber() })],
            ["niveauMaximal", t(`domaine.niveauxOffre.${offre.dataLevel}`)],
            ["validite", demande.approvedDays !== null ? duree(t, demande.approvedDays) : null],
          ]),
        ),
        t("courriels.abonnementApprouve.souscrire", { fournisseur: offre.supplier }),
        t("courriels.abonnementApprouve.regles", { regles: langue === "en" ? (offre.rulesEn ?? offre.rulesFr) : offre.rulesFr }),
        echeance ? t("courriels.abonnementApprouve.declarer", { date: echeance }) : t("courriels.abonnementApprouve.declarerSansEcheance"),
        ...(remplace ? [t("courriels.abonnementApprouve.remplace", { offre: remplace })] : []),
      ],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Ticket #59 : renouvellement approuvé ; l'échéance de l'abonnement est reportée, sans rien d'autre à faire. */
export async function notifyRenewalApproved(
  deps: NotificationDeps,
  demande: AccessRequest,
  offre: Pick<SubscriptionOffer, "supplier" | "name">,
  echeance: Date,
): Promise<void> {
  const valeurs = { offre: libelleOffre(offre), equipe: demande.teamAlias, date: echeance };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.renouvellementApprouve.sujet"),
      paragraphes: [t("courriels.bonjour", { nom: nom(demande) }), t("courriels.renouvellementApprouve.corps", valeurs)],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Ticket #59 : rappel d'échéance d'un abonnement, un mois, sept jours et la veille ; son renouvellement se demande dans « Mes abonnements ». */
export async function notifySubscriptionExpiryReminder(
  deps: NotificationDeps,
  abonnement: Pick<Subscription, "holderUid" | "holderName" | "holderEmail" | "teamAlias" | "expiresAt">,
  offre: Pick<SubscriptionOffer, "supplier" | "name">,
  jours: number,
): Promise<void> {
  const valeurs = { offre: libelleOffre(offre), equipe: abonnement.teamAlias, date: abonnement.expiresAt, jours, fournisseur: offre.supplier };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.rappelEcheance.sujet", valeurs),
      paragraphes: [t("courriels.bonjour", { nom: titulaire(abonnement) }), t("courriels.rappelEcheance.corps", valeurs), t("courriels.rappelEcheance.suite", valeurs)],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [abonnement.holderEmail], message);
}

/** Demande refusée, avec le motif du refus et le rappel de la demande. */
export async function notifyRefused(deps: NotificationDeps, demande: DemandeAvecOffre, motif: string): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.demandeRefusee.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t("courriels.demandeRefusee.corps", { type: demande.kind, equipe: demande.teamAlias }),
        t("courriels.demandeRefusee.motif", { motif }),
        avecRecap(t("courriels.rappelDemande"), recapDemande(t, demande)),
        t("courriels.demandeRefusee.suite"),
      ],
    }),
    lienVers(deps, "/demandes"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Complément demandé, avec le commentaire de l'admin et le rappel de la demande. */
export async function notifyCompletionRequested(deps: NotificationDeps, demande: DemandeAvecOffre, commentaire: string | null): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.complementDemande.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t("courriels.complementDemande.corps", { type: demande.kind, equipe: demande.teamAlias }),
        ...(commentaire ? [t("courriels.complementDemande.commentaire", { commentaire })] : []),
        avecRecap(t("courriels.rappelDemande"), recapDemande(t, demande)),
        t("courriels.complementDemande.suite"),
      ],
    }),
    lienVers(deps, "/demandes"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Demande d'accès acceptée, avec l'équipe retenue et la suite : demander une clé. */
export async function notifyMembershipApproved(deps: NotificationDeps, demande: AccessRequest, equipe: string): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.adhesionAcceptee.sujet"),
      paragraphes: [t("courriels.bonjour", { nom: nom(demande) }), t("courriels.adhesionAcceptee.corps", { equipe }), t("courriels.adhesionAcceptee.suite")],
    }),
    lienVers(deps, "/demandes/nouvelle"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Rappel J-3 : une clé approuvée attend son retrait avant l'échéance. */
export async function notifyPickupReminder(deps: NotificationDeps, demande: AccessRequest, echeance: Date): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.rappelRetrait.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t("courriels.rappelRetrait.corps", { equipe: demande.teamAlias, date: echeance }),
        avecRecap(t("courriels.rappelApprobation"), recapApprobation(t, demande)),
      ],
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Spécification #51 : rappel trois jours avant l'échéance de déclaration d'un abonnement approuvé. */
export async function notifyDeclarationReminder(deps: NotificationDeps, demande: AccessRequest, offre: SubscriptionOffer, echeance: Date): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.rappelDeclaration.sujet"),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t("courriels.rappelDeclaration.corps", { offre: libelleOffre(offre), equipe: demande.teamAlias, date: echeance }),
      ],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/**
 * Ticket #58 : demande de résiliation, quelle qu'en soit l'origine (responsable, admin, sortie de l'équipe), annoncée au
 * titulaire avec le motif éventuel et l'échéance de la déclaration de la résiliation.
 */
export async function notifyTerminationRequested(
  deps: NotificationDeps,
  abonnement: Pick<Subscription, "holderUid" | "holderName" | "holderEmail" | "teamAlias" | "terminationOrigin" | "terminationReason">,
  offre: Pick<SubscriptionOffer, "supplier" | "name">,
  echeance: Date | null,
): Promise<void> {
  const valeurs = { origine: abonnement.terminationOrigin ?? "ADMIN", offre: libelleOffre(offre), equipe: abonnement.teamAlias };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.demandeResiliation.sujet", valeurs),
      paragraphes: [
        t("courriels.bonjour", { nom: titulaire(abonnement) }),
        t("courriels.demandeResiliation.corps", valeurs),
        ...(abonnement.terminationReason ? [t("courriels.demandeResiliation.motif", { motif: abonnement.terminationReason })] : []),
        echeance
          ? t("courriels.demandeResiliation.suite", { fournisseur: offre.supplier, date: echeance })
          : t("courriels.demandeResiliation.suiteSansEcheance", { fournisseur: offre.supplier }),
      ],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [abonnement.holderEmail], message);
}

/** Ticket #58 : un admin a déclaré la résiliation à la place du titulaire, qui en est prévenu à l'adresse donnée. */
export async function notifyTerminationDeclaredByAdmin(
  deps: NotificationDeps,
  abonnement: Pick<Subscription, "holderUid" | "holderName" | "teamAlias">,
  offre: Pick<SubscriptionOffer, "supplier" | "name">,
  date: Date,
  email: string,
): Promise<void> {
  const valeurs = { offre: libelleOffre(offre), equipe: abonnement.teamAlias, date, fournisseur: offre.supplier };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.resiliationParAdmin.sujet", valeurs),
      paragraphes: [t("courriels.bonjour", { nom: titulaire(abonnement) }), t("courriels.resiliationParAdmin.corps", valeurs)],
    }),
    lienVers(deps, "/abonnements"),
  );
  await envoyer(deps, [email], message);
}

/**
 * Ticket #58 : résiliation demandée, non déclarée dans le délai de retrait ; l'alerte, envoyée une seule fois par la
 * tâche quotidienne, va aux admins et aux responsables de l'équipe désignés par elle.
 */
export async function notifyUndeclaredTermination(
  deps: NotificationDeps,
  abonnement: Pick<Subscription, "holderUid" | "teamId" | "teamAlias" | "terminationRequestedAt">,
  offre: Pick<SubscriptionOffer, "supplier" | "name">,
  responsables: string[],
): Promise<void> {
  const valeurs = { offre: libelleOffre(offre), titulaire: abonnement.holderUid, equipe: abonnement.teamAlias, date: abonnement.terminationRequestedAt ?? new Date(0) };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.alerteResiliation.sujet", valeurs),
      paragraphes: [t("courriels.bonjourAdmins"), t("courriels.alerteResiliation.corps", valeurs)],
    }),
    lienVers(deps, `/gestion/abonnements?equipe=${encodeURIComponent(abonnement.teamId)}`),
  );
  await envoyer(deps, adminsEtResponsables(deps, responsables), message);
}

/** Rappel d'expiration (un mois, sept jours ou la veille) : son renouvellement se demande dans « Mes clés ». */
export async function notifyExpiryReminder(deps: NotificationDeps, demande: AccessRequest & { keyAlias: string; keyExpiresAt: Date }, jours: number): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.rappelExpiration.sujet", { alias: demande.keyAlias }),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t("courriels.rappelExpiration.corps", { alias: demande.keyAlias, date: demande.keyExpiresAt, delai: t("courriels.rappelExpiration.delai", { jours }) }),
        avecRecap(t("courriels.rappelCle"), recapCle(t, demande)),
        t("courriels.rappelExpiration.suite"),
      ],
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Action d'un admin ou d'un responsable de l'équipe sur la clé d'un titulaire : révocation, blocage ou déblocage (jamais pour ses propres actions). */
export async function notifyAdminKeyAction(
  deps: NotificationDeps,
  demande: AccessRequest & { keyAlias: string },
  action: "revocation" | "blocage" | "deblocage",
  role: "admin" | "responsable" = "admin",
): Promise<void> {
  const cle = { revocation: "cleRevoquee", blocage: "cleBloquee", deblocage: "cleDebloquee" }[action] as "cleRevoquee" | "cleBloquee" | "cleDebloquee";
  const message = bilingue(
    (t) => ({
      sujet: t(`courriels.${cle}.sujet`, { alias: demande.keyAlias }),
      paragraphes: [
        t("courriels.bonjour", { nom: nom(demande) }),
        t(`courriels.${cle}.corps`, { alias: demande.keyAlias, role }),
        avecRecap(t("courriels.rappelCle"), recapCle(t, demande)),
      ],
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [demande.requesterEmail], message);
}

/** Changement dans une équipe (F-53 et F-54), annoncé aux admins et aux responsables de l'équipe. */
export type TeamChange =
  | { type: "creee" }
  | { type: "renommee"; ancienNom: string }
  | { type: "supprimee" }
  | { type: "membreAjoute"; membre: string }
  | { type: "membreSorti"; membre: string }
  | { type: "responsableDesigne"; responsable: string }
  | { type: "responsableRetire"; responsable: string }
  | { type: "budget"; plafond: { montant: number; periode: string } | null }
  | { type: "decision"; decision: "approuvee" | "refusee" | "complement" | "adhesion" | "abonnement"; demandeur: string; demandeId: string }
  | { type: "cle"; action: "revocation" | "blocage" | "deblocage"; alias: string; titulaire: string }
  | { type: "resiliationDemandee"; titulaire: string; offre: string };

/**
 * F-53 et F-54 : un changement dans une équipe est annoncé aux admins et aux responsables de l'équipe que le service
 * désigne (tous sauf l'auteur), avec son auteur et le lien vers la page de l'équipe. Les admins ne sont prévenus que des
 * décisions des responsables (récit 35) : la décision d'un admin sur une demande, une clé ou un abonnement (demande de
 * résiliation) ne va qu'aux responsables de l'équipe (récit 36).
 */
export async function notifyTeamChange(
  deps: NotificationDeps,
  changement: TeamChange & { teamId: string; equipe: string; auteur: { uid: string; name: string; isAdmin: boolean } },
  responsables: string[] = [],
): Promise<void> {
  const valeurs = (t: Traducteur) => ({
    equipe: changement.equipe,
    auteur: auteur(changement.auteur),
    ...("ancienNom" in changement ? { ancienNom: changement.ancienNom } : {}),
    ...("membre" in changement ? { membre: changement.membre } : {}),
    ...("responsable" in changement ? { responsable: changement.responsable } : {}),
    ...(changement.type === "decision" ? { decision: changement.decision, demandeur: changement.demandeur } : {}),
    ...(changement.type === "cle" ? { action: changement.action, alias: changement.alias, titulaire: changement.titulaire } : {}),
    ...(changement.type === "resiliationDemandee" ? { titulaire: changement.titulaire, offre: changement.offre } : {}),
    ...(changement.type === "budget" ? { plafond: changement.plafond ? "oui" : "non", budget: budgetEquipe(t, changement.plafond) } : {}),
  });
  const message = bilingue(
    (t) => ({
      sujet: t(`courriels.equipe.${changement.type}.sujet`, valeurs(t)),
      paragraphes: [t("courriels.bonjourAdmins"), t(`courriels.equipe.${changement.type}.corps`, valeurs(t))],
    }),
    // Une équipe supprimée n'a plus de page : le lien mène à la liste des équipes.
    lienVers(
      deps,
      changement.type === "supprimee"
        ? "/gestion/equipes"
        : changement.type === "decision"
          ? `/gestion/demandes/${changement.demandeId}`
          : changement.type === "cle"
            ? "/gestion/cles"
            : changement.type === "resiliationDemandee"
              ? `/gestion/abonnements?equipe=${encodeURIComponent(changement.teamId)}`
              : `/gestion/equipes/${changement.teamId}`,
    ),
  );
  const decisionDUnAdmin = (changement.type === "decision" || changement.type === "cle" || changement.type === "resiliationDemandee") && changement.auteur.isAdmin;
  await envoyer(deps, adminsEtResponsables(deps, responsables, !decisionDUnAdmin), message);
}

/** Budget d'équipe tel que le nomment les courriels : « 100,00 € par période de 30 jours », ou « sans limite ». */
function budgetEquipe(t: Traducteur, plafond: { montant: number; periode: string } | null): string {
  return plafond
    ? t("courriels.recap.budgetValeur", { montant: plafond.montant, periode: periode(t, plafond.periode) })
    : t("courriels.equipe.budget.sansLimite");
}

/**
 * F-54 : alerte de budget d'équipe, à 80 % puis à 100 %, aux admins et aux responsables de l'équipe désignés par la
 * tâche quotidienne : la dépense de la période, la fin de celle-ci et ce qu'il advient des clés de l'équipe.
 */
export async function notifyTeamBudgetAlert(
  deps: NotificationDeps,
  alerte: { teamId: string; equipe: string; seuil: number; depense: number; budget: number; fin: Date | null },
  responsables: string[],
): Promise<void> {
  const message = bilingue((t) => {
    const valeurs = {
      equipe: alerte.equipe,
      seuil: alerte.seuil,
      depense: alerte.depense,
      budget: alerte.budget,
      fin: alerte.fin ? t("courriels.recap.date", { date: alerte.fin }) : "aucune",
      niveau: alerte.seuil >= 100 ? "atteint" : "alerte",
    };
    return {
      sujet: t("courriels.alerteBudget.sujet", valeurs),
      paragraphes: [t("courriels.bonjourAdmins"), [t("courriels.alerteBudget.corps", valeurs), t("courriels.alerteBudget.suite", valeurs)].join(" ")],
    };
  }, lienVers(deps, `/gestion/equipes/${alerte.teamId}`));
  await envoyer(deps, adminsEtResponsables(deps, responsables), message);
}

/** Auteur d'une action, tel que le nomment les courriels : « Jeanne Dupont (jdupont) ». */
const auteur = (a: { uid: string; name: string }) => `${a.name} (${a.uid})`;

/** F-53 : le salarié ajouté directement à une équipe par un admin en est prévenu. */
export async function notifyMemberAdded(deps: NotificationDeps, ajout: { email: string; equipe: string; auteur: { uid: string; name: string } }): Promise<void> {
  const valeurs = { equipe: ajout.equipe, auteur: auteur(ajout.auteur) };
  const message = bilingue(
    (t) => ({ sujet: t("courriels.ajoutMembre.sujet", valeurs), paragraphes: [t("courriels.bonjourAdmins"), t("courriels.ajoutMembre.corps", valeurs)] }),
    lienVers(deps, "/demandes/nouvelle"),
  );
  await envoyer(deps, [ajout.email], message);
}

/** F-54 : le salarié sorti d'une équipe en est prévenu, avec ses clés révoquées et le nombre de ses demandes annulées. */
export async function notifyMemberRemoved(
  deps: NotificationDeps,
  sortie: { email: string; equipe: string; auteur: { uid: string; name: string }; cles: string[]; demandes: number },
): Promise<void> {
  const valeurs = { equipe: sortie.equipe, auteur: auteur(sortie.auteur) };
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.sortieMembre.sujet", valeurs),
      paragraphes: [
        t("courriels.bonjourAdmins"),
        [
          t("courriels.sortieMembre.corps", valeurs),
          ...(sortie.cles.length > 0 ? [t("courriels.sortieMembre.cles", { cles: sortie.cles.join(", ") })] : []),
          ...(sortie.demandes > 0 ? [t("courriels.sortieMembre.demandes", { nombre: sortie.demandes })] : []),
        ].join(" "),
      ],
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [sortie.email], message);
}

/** F-54 : le salarié désigné responsable d'une équipe en est prévenu. */
export async function notifyManagerDesignated(deps: NotificationDeps, designation: { email: string; equipe: string; auteur: { uid: string; name: string } }): Promise<void> {
  const valeurs = { equipe: designation.equipe, auteur: auteur(designation.auteur) };
  const message = bilingue(
    (t) => ({ sujet: t("courriels.designationResponsable.sujet", valeurs), paragraphes: [t("courriels.bonjourAdmins"), t("courriels.designationResponsable.corps", valeurs)] }),
    lienVers(deps, "/gestion/demandes"),
  );
  await envoyer(deps, [designation.email], message);
}

/** Réglage d'une intégration dont un changement est annoncé : nom, périmètre, adresses ou plafond. */
export type ChampIntegration = "nom" | "perimetres" | "adresses" | "plafond";

/** Changement dans le registre des intégrations (spécification #71). */
export type IntegrationChange =
  | { type: "creee"; perimetres: string[]; adresses: string[]; plafond: number }
  | { type: "modifiee"; modifications: { champ: ChampIntegration; avant: string | number | string[]; apres: string | number | string[] }[] }
  | { type: "cleAjoutee" | "cleHorsService"; kid: string; algorithme: string; empreinte: string }
  | { type: "activee"; perimetres: string[] }
  | { type: "desactivee" };

/** Libellé du récapitulatif pour chaque réglage d'une intégration. */
const LIBELLES_INTEGRATION: Record<ChampIntegration, Libelle> = { nom: "nom", perimetres: "perimetre", adresses: "adresses", plafond: "plafond" };

/**
 * Spécification #71 : chaque changement dans le registre des intégrations (déclaration, modification, clé ajoutée ou
 * mise hors service, activation, désactivation) est annoncé à tous les admins, avec son auteur, pour qu'aucune intégration ne
 * soit ajoutée ou modifiée à leur insu ; le lien mène à l'intégration dans l'onglet « Intégrations ».
 */
export async function notifyIntegrationChange(
  deps: NotificationDeps,
  changement: IntegrationChange & { id: string; nom: string; auteur: { uid: string; name: string } },
): Promise<void> {
  const valeurs = { id: changement.id, nom: changement.nom, auteur: auteur(changement.auteur) };
  const message = bilingue((t) => {
    // Liste de valeurs (périmètres, adresses) : « aucun » quand elle est vide.
    const texte = (v: string | number | string[]) => (Array.isArray(v) ? v.join(", ") || t("courriels.integration.aucun") : String(v));
    const valeur = (champ: ChampIntegration, v: string | number | string[]) => (champ === "plafond" ? t("courriels.recap.plafondValeur", { nombre: Number(v) }) : texte(v));
    const details =
      changement.type === "creee"
        ? lignes(t, [
            ["perimetre", texte(changement.perimetres)],
            ["adresses", texte(changement.adresses)],
            ["plafond", valeur("plafond", changement.plafond)],
          ])
        : changement.type === "modifiee"
          ? changement.modifications.map((m) =>
              t("courriels.integration.modification", {
                libelle: t(`courriels.recap.${LIBELLES_INTEGRATION[m.champ]}`),
                avant: valeur(m.champ, m.avant),
                apres: valeur(m.champ, m.apres),
              }),
            )
          : changement.type === "cleAjoutee" || changement.type === "cleHorsService"
            ? lignes(t, [
                ["kid", changement.kid],
                ["algorithme", changement.algorithme],
                ["empreinte", changement.empreinte],
              ])
            : [];
    const corps = t(`courriels.integration.${changement.type}.corps`, {
      ...valeurs,
      perimetres: changement.type === "activee" ? texte(changement.perimetres) : "",
    });
    return {
      sujet: t(`courriels.integration.${changement.type}.sujet`, valeurs),
      paragraphes: [t("courriels.bonjourAdmins"), avecRecap(corps, details), t("courriels.integration.alerte")],
    };
  }, lienVers(deps, `/gestion/integrations?integration=${encodeURIComponent(changement.id)}`));
  await envoyer(deps, deps.adminEmails ?? [], message);
}
