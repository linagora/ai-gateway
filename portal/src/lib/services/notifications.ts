import { createTranslator } from "next-intl";
import type { Mailer, Message } from "@/lib/courriel";
import type { DataLevel } from "@/lib/policy";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

/** Dépendances des notifications : sans expéditeur, rien n'est envoyé et rien n'est bloqué. */
export interface NotificationDeps {
  mailer?: Mailer | null;
  adminEmails?: string[];
  /** Adresse publique du portail, pour les liens des courriels. */
  portalUrl?: string;
}

const TRADUCTEURS = [
  createTranslator({ locale: "fr", messages: fr, timeZone: "Europe/Paris" }),
  createTranslator({ locale: "en", messages: en, timeZone: "Europe/Paris" }),
] as const;
type Traducteur = (typeof TRADUCTEURS)[number];

/**
 * Courriel bilingue : le même contenu en français puis en anglais, avec le lien. Le contenu de chaque
 * langue est calculé par `contenu`, qui reçoit le traducteur de cette langue (textes des dictionnaires).
 */
function bilingue(contenu: (t: Traducteur) => { sujet: string; corps: string }, lien: string): Omit<Message, "to"> {
  const [francais, anglais] = TRADUCTEURS.map((t) => ({ ...contenu(t), lien: t("courriels.lien", { url: lien }) }));
  return {
    subject: `${francais.sujet} / ${anglais.sujet}`,
    text: [francais.corps, francais.lien, "", "—", "", anglais.corps, anglais.lien, "", "Portail IA Linagora / Linagora AI Portal"].join("\n"),
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

/** F-30 : chaque nouvelle demande de clé ou d'adhésion est notifiée aux admins, avec un lien vers sa fiche. */
export async function notifyNewRequest(
  deps: NotificationDeps,
  demande: { id: string; kind: "CLE" | "ADHESION_EQUIPE"; requesterUid: string; teamAlias: string; dataLevel: DataLevel | null },
): Promise<void> {
  const message = bilingue(
    (t) =>
      demande.kind === "CLE"
        ? {
            sujet: t("courriels.nouvelleDemandeCle.sujet"),
            corps: t("courriels.nouvelleDemandeCle.corps", {
              uid: demande.requesterUid,
              equipe: demande.teamAlias,
              niveau: demande.dataLevel ? t(`domaine.niveaux.${demande.dataLevel}`) : "—",
            }),
          }
        : {
            sujet: t("courriels.nouvelleDemandeAdhesion.sujet"),
            corps: t("courriels.nouvelleDemandeAdhesion.corps", { uid: demande.requesterUid, equipe: demande.teamAlias }),
          },
    lienVers(deps, `/gestion/demandes/${demande.id}`),
  );
  await envoyer(deps, deps.adminEmails ?? [], message);
}

/** F-40 : demande de clé approuvée, avec l'échéance de retrait et un lien vers « Mes clés » ; jamais de clé. */
export async function notifyKeyApproved(deps: NotificationDeps, avis: { to: string; equipe: string; echeance: Date | null }): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.demandeApprouvee.sujet"),
      corps: avis.echeance
        ? t("courriels.demandeApprouvee.corps", { equipe: avis.equipe, date: avis.echeance })
        : t("courriels.demandeApprouvee.corpsSansEcheance", { equipe: avis.equipe }),
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Demande refusée, avec le motif. */
export async function notifyRefused(deps: NotificationDeps, avis: { to: string; equipe: string; motif: string }): Promise<void> {
  const message = bilingue(
    (t) => ({ sujet: t("courriels.demandeRefusee.sujet"), corps: t("courriels.demandeRefusee.corps", { equipe: avis.equipe, motif: avis.motif }) }),
    lienVers(deps, "/demandes"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Complément demandé, avec le commentaire de l'admin. */
export async function notifyCompletionRequested(deps: NotificationDeps, avis: { to: string; equipe: string; commentaire: string | null }): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.complementDemande.sujet"),
      corps: t("courriels.complementDemande.corps", { equipe: avis.equipe, commentaire: avis.commentaire || "—" }),
    }),
    lienVers(deps, "/demandes"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Adhésion acceptée, avec l'équipe retenue. */
export async function notifyMembershipApproved(deps: NotificationDeps, avis: { to: string; equipe: string }): Promise<void> {
  const message = bilingue(
    (t) => ({ sujet: t("courriels.adhesionAcceptee.sujet"), corps: t("courriels.adhesionAcceptee.corps", { equipe: avis.equipe }) }),
    lienVers(deps, "/demandes/nouvelle"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Rappel J-3 : une clé approuvée attend son retrait avant l'échéance. */
export async function notifyPickupReminder(deps: NotificationDeps, avis: { to: string; equipe: string; echeance: Date }): Promise<void> {
  const message = bilingue(
    (t) => ({ sujet: t("courriels.rappelRetrait.sujet"), corps: t("courriels.rappelRetrait.corps", { equipe: avis.equipe, date: avis.echeance }) }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Rappel d'expiration (un mois, sept jours ou la veille) : son renouvellement se demande dans « Mes clés ». */
export async function notifyExpiryReminder(deps: NotificationDeps, avis: { to: string; alias: string; echeance: Date; jours: number }): Promise<void> {
  const message = bilingue(
    (t) => ({
      sujet: t("courriels.rappelExpiration.sujet", { alias: avis.alias }),
      corps: t("courriels.rappelExpiration.corps", {
        alias: avis.alias,
        date: avis.echeance,
        delai: t("courriels.rappelExpiration.delai", { jours: avis.jours }),
      }),
    }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [avis.to], message);
}

/** Action d'un admin sur la clé d'un titulaire : révocation, blocage ou déblocage (jamais pour ses propres actions). */
export async function notifyAdminKeyAction(
  deps: NotificationDeps,
  avis: { to: string; alias: string; action: "revocation" | "blocage" | "deblocage" },
): Promise<void> {
  const cle = { revocation: "cleRevoquee", blocage: "cleBloquee", deblocage: "cleDebloquee" }[avis.action] as "cleRevoquee" | "cleBloquee" | "cleDebloquee";
  const message = bilingue(
    (t) => ({ sujet: t(`courriels.${cle}.sujet`, { alias: avis.alias }), corps: t(`courriels.${cle}.corps`, { alias: avis.alias }) }),
    lienVers(deps, "/cles"),
  );
  await envoyer(deps, [avis.to], message);
}
