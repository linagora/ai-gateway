import { createTranslator } from "next-intl";
import type { AccessRequest } from "@/generated/prisma/client";
import type { Mailer, Message } from "@/lib/courriel";
import { DUREES_VALIDITE } from "@/lib/durees";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

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

/**
 * Courriel bilingue : le même contenu en français puis en anglais, chacun suivi du lien. Le contenu de chaque
 * langue est calculé par `contenu`, qui reçoit le traducteur de cette langue (textes des dictionnaires).
 */
function bilingue(contenu: (t: Traducteur) => Contenu, lien: string): Omit<Message, "to"> {
  const [francais, anglais] = TRADUCTEURS.map((t) => {
    const { sujet, paragraphes } = contenu(t);
    return { sujet, corps: [...paragraphes, t("courriels.lien", { url: lien })].join("\n\n") };
  });
  return {
    subject: `${PREFIXE_OBJET} ${francais.sujet} / ${anglais.sujet}`,
    text: [francais.corps, "* * *", anglais.corps, "Portail IA Linagora / Linagora AI Portal"].join("\n\n"),
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

const lienVers = (deps: NotificationDeps, chemin: string) => `${(deps.portalUrl ?? "").replace(/\/$/, "")}${chemin}`;

/** Nom du demandeur ; les demandes antérieures à son enregistrement n'ont que son identifiant. */
const nom = (r: AccessRequest) => r.requesterName || r.requesterUid;

/** Nom d'une durée de validité : « 3 mois », « N'expire jamais », ou « 60 jours » hors de la liste proposée. */
function duree(t: Traducteur, jours: number): string {
  const proposee = DUREES_VALIDITE.find((d) => d === jours);
  return proposee !== undefined ? t(`domaine.durees.${proposee}`) : t("domaine.dureeEnJours", { nombre: jours });
}

/** Période de budget au format LiteLLM (30d…), en jours quand c'est possible. */
function periode(t: Traducteur, budgetDuration: string): string {
  const jours = /^(\d+)d$/.exec(budgetDuration);
  return jours ? t("domaine.dureeEnJours", { nombre: Number(jours[1]) }) : budgetDuration;
}

/** Libellés des lignes d'un récapitulatif (dictionnaires, espace « courriels.recap »). */
type Libelle = "equipe" | "niveau" | "modeles" | "modelesAccordes" | "projet" | "motif" | "dureeSouhaitee" | "budget" | "validite" | "expiration";

/** Lignes « - Libellé : valeur » d'un récapitulatif ; les valeurs absentes sont omises. */
function lignes(t: Traducteur, champs: [libelle: Libelle, valeur: string | null | undefined][]): string[] {
  return champs.flatMap(([libelle, valeur]) => (valeur ? [t("courriels.recap.ligne", { libelle: t(`courriels.recap.${libelle}`), valeur })] : []));
}

/** Ce que le salarié a demandé : équipe, niveau, modèles, projet, motif et durée souhaitée. */
function recapDemande(t: Traducteur, r: AccessRequest): string[] {
  return lignes(t, [
    ["equipe", r.teamAlias],
    ["niveau", r.dataLevel && t(`domaine.niveaux.${r.dataLevel}`)],
    ["modeles", r.models.join(", ")],
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
export async function notifyNewRequest(deps: NotificationDeps, demande: AccessRequest, responsables: string[] = []): Promise<void> {
  const qui = { nom: nom(demande), email: demande.requesterEmail };
  const message = bilingue(
    (t) =>
      demande.kind === "CLE"
        ? {
            sujet: t("courriels.nouvelleDemandeCle.sujet", qui),
            paragraphes: [t("courriels.bonjourAdmins"), avecRecap(t("courriels.nouvelleDemandeCle.corps", qui), recapDemande(t, demande)), t("courriels.examiner")],
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
  await envoyer(deps, [...new Set([...(deps.adminEmails ?? []), ...responsables])], message);
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

/** Demande refusée, avec le motif du refus et le rappel de la demande. */
export async function notifyRefused(deps: NotificationDeps, demande: AccessRequest, motif: string): Promise<void> {
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
export async function notifyCompletionRequested(deps: NotificationDeps, demande: AccessRequest, commentaire: string | null): Promise<void> {
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

/** Action d'un admin sur la clé d'un titulaire : révocation, blocage ou déblocage (jamais pour ses propres actions). */
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

/** Changement dans une équipe (F-53), annoncé aux admins. */
export type TeamChange =
  | { type: "creee" }
  | { type: "renommee"; ancienNom: string }
  | { type: "supprimee" }
  | { type: "membreAjoute"; membre: string }
  | { type: "membreSorti"; membre: string }
  | { type: "responsableDesigne"; responsable: string }
  | { type: "responsableRetire"; responsable: string }
  | { type: "decision"; decision: "approuvee" | "refusee" | "complement" | "adhesion"; demandeur: string; demandeId: string }
  | { type: "cle"; action: "revocation" | "blocage" | "deblocage"; alias: string; titulaire: string };

/**
 * F-53 et F-54 : un changement dans une équipe est annoncé aux admins et aux responsables de l'équipe que le service
 * désigne (tous sauf l'auteur), avec son auteur et le lien vers la page de l'équipe.
 */
export async function notifyTeamChange(
  deps: NotificationDeps,
  changement: TeamChange & { teamId: string; equipe: string; auteur: { uid: string; name: string } },
  responsables: string[] = [],
): Promise<void> {
  const valeurs = {
    equipe: changement.equipe,
    auteur: auteur(changement.auteur),
    ...("ancienNom" in changement ? { ancienNom: changement.ancienNom } : {}),
    ...("membre" in changement ? { membre: changement.membre } : {}),
    ...("responsable" in changement ? { responsable: changement.responsable } : {}),
    ...(changement.type === "decision" ? { decision: changement.decision, demandeur: changement.demandeur } : {}),
    ...(changement.type === "cle" ? { action: changement.action, alias: changement.alias, titulaire: changement.titulaire } : {}),
  };
  const message = bilingue(
    (t) => ({
      sujet: t(`courriels.equipe.${changement.type}.sujet`, valeurs),
      paragraphes: [t("courriels.bonjourAdmins"), t(`courriels.equipe.${changement.type}.corps`, valeurs)],
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
            : `/gestion/equipes/${changement.teamId}`,
    ),
  );
  await envoyer(deps, [...new Set([...(deps.adminEmails ?? []), ...responsables])], message);
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
