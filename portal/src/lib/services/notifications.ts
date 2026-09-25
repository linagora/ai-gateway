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

const TRADUCTEURS = [createTranslator({ locale: "fr", messages: fr }), createTranslator({ locale: "en", messages: en })] as const;
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
